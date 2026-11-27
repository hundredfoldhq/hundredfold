use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use hundredfold_voice_core::{diag_info, diag_warn};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::header,
    protocol::{frame::coding::CloseCode, CloseFrame},
    Message,
};

use crate::{
    commands::{trusted_document, NativeError, NativeState},
    credentials::SharedCredentialStore,
    origin::{CanonicalOrigin, GatewayTarget},
};

static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

pub enum OutgoingFrame {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

pub struct OpenStream {
    pub origin: CanonicalOrigin,
    pub sender: mpsc::UnboundedSender<OutgoingFrame>,
}

pub type StreamRegistry = Arc<Mutex<HashMap<String, OpenStream>>>;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum StreamInput {
    Open {
        target: GatewayTarget,
        path: String,
    },
    Send {
        stream_id: String,
        text: Option<String>,
        bytes_base64: Option<String>,
    },
    Close {
        stream_id: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum StreamEvent {
    Opened {
        stream_id: String,
    },
    Message {
        stream_id: String,
        text: Option<String>,
        bytes_base64: Option<String>,
    },
    Closed {
        stream_id: String,
        code: Option<u16>,
        reason: String,
    },
    Failed {
        stream_id: String,
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamReceipt {
    pub stream_id: String,
}

fn confine(window: &WebviewWindow) -> Result<(), NativeError> {
    let url = window.url().map_err(|_| NativeError::denied())?;
    trusted_document(window.label(), &url)
        .then_some(())
        .ok_or_else(NativeError::denied)
}

#[tauri::command]
pub async fn stream(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: StreamInput,
    on_event: Channel<StreamEvent>,
) -> Result<StreamReceipt, NativeError> {
    confine(&window)?;
    match input {
        StreamInput::Open { target, path } => {
            let (stream_id, _) = open_gateway_stream(
                &state.credentials,
                &state.streams,
                &target,
                &path,
                ChannelSink(on_event),
            )?;
            Ok(StreamReceipt { stream_id })
        }
        StreamInput::Send {
            stream_id,
            text,
            bytes_base64,
        } => {
            let frame = match (text, bytes_base64) {
                (Some(text), None) => OutgoingFrame::Text(text),
                (None, Some(bytes)) => OutgoingFrame::Binary(
                    BASE64
                        .decode(bytes)
                        .map_err(|_| NativeError::invalid_request())?,
                ),
                _ => return Err(NativeError::invalid_request()),
            };
            state
                .streams
                .lock()
                .map_err(|_| NativeError::transport())?
                .get(&stream_id)
                .ok_or_else(NativeError::unknown_stream)?
                .sender
                .send(frame)
                .map_err(|_| NativeError::unknown_stream())?;
            Ok(StreamReceipt { stream_id })
        }
        StreamInput::Close { stream_id } => {
            if let Some(open) = state
                .streams
                .lock()
                .map_err(|_| NativeError::transport())?
                .remove(&stream_id)
            {
                let _ = open.sender.send(OutgoingFrame::Close);
            }
            Ok(StreamReceipt { stream_id })
        }
    }
}

/// Where a gateway socket's events go. The `stream` command forwards them to
/// the WebView over a Tauri channel; the native voice session consumes them in
/// Rust, so audio never reaches JavaScript. Methods that return `bool` stop
/// the socket when they return `false`.
pub trait SocketSink: Send + 'static {
    fn opened(&self, stream_id: &str) -> bool;
    fn text(&self, stream_id: &str, text: String) -> bool;
    fn binary(&self, stream_id: &str, bytes: Vec<u8>) -> bool;
    fn closed(&self, stream_id: &str, code: Option<u16>, reason: String);
    fn failed(&self, stream_id: &str);
}

struct ChannelSink(Channel<StreamEvent>);

impl SocketSink for ChannelSink {
    fn opened(&self, stream_id: &str) -> bool {
        self.0
            .send(StreamEvent::Opened {
                stream_id: stream_id.to_owned(),
            })
            .is_ok()
    }

    fn text(&self, stream_id: &str, text: String) -> bool {
        self.0
            .send(StreamEvent::Message {
                stream_id: stream_id.to_owned(),
                text: Some(text),
                bytes_base64: None,
            })
            .is_ok()
    }

    fn binary(&self, stream_id: &str, bytes: Vec<u8>) -> bool {
        self.0
            .send(StreamEvent::Message {
                stream_id: stream_id.to_owned(),
                text: None,
                bytes_base64: Some(BASE64.encode(bytes)),
            })
            .is_ok()
    }

    fn closed(&self, stream_id: &str, code: Option<u16>, reason: String) {
        let _ = self.0.send(StreamEvent::Closed {
            stream_id: stream_id.to_owned(),
            code,
            reason,
        });
    }

    fn failed(&self, stream_id: &str) {
        let _ = self.0.send(StreamEvent::Failed {
            stream_id: stream_id.to_owned(),
            code: "stream-failed",
            message: "The gateway stream could not connect",
        });
    }
}

/// Opens an authenticated gateway WebSocket for a paired origin: the same
/// credential, origin rules and registry entry (so `forget` closes it) whether
/// the consumer is the WebView or the native voice session.
pub fn open_gateway_stream(
    credentials: &SharedCredentialStore,
    streams: &StreamRegistry,
    target: &GatewayTarget,
    path: &str,
    sink: impl SocketSink,
) -> Result<(String, mpsc::UnboundedSender<OutgoingFrame>), NativeError> {
    let origin = CanonicalOrigin::parse(&target.origin)?;
    let credential = credentials
        .get(&origin)?
        .ok_or_else(NativeError::not_paired)?;
    let mut url = origin.request_url(path)?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| NativeError::invalid_origin())?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| NativeError::invalid_path())?;
    request.headers_mut().insert(
        header::COOKIE,
        credential
            .cookie_header
            .parse()
            .map_err(|_| NativeError::credential_store())?,
    );
    let id = format!("stream-{}", NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = mpsc::unbounded_channel();
    streams
        .lock()
        .map_err(|_| NativeError::transport())?
        .insert(
            id.clone(),
            OpenStream {
                origin,
                sender: sender.clone(),
            },
        );
    tauri::async_runtime::spawn(run_socket(
        id.clone(),
        request,
        receiver,
        sink,
        streams.clone(),
    ));
    Ok((id, sender))
}

/// A close initiated by this side is a normal closure (1000), so the gateway sees a
/// clean end rather than "no status".
fn normal_close() -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::Normal,
        reason: "".into(),
    }))
}

/// What crossed one socket, for the line logged when it ends.
#[derive(Default)]
struct SocketStats {
    text_rx: u64,
    binary_rx: u64,
    bytes_rx: u64,
    text_tx: u64,
    binary_tx: u64,
    bytes_tx: u64,
    pings_rx: u64,
    last_rx: Option<Instant>,
    max_rx_gap_ms: u128,
}

impl SocketStats {
    fn received(&mut self) {
        let now = Instant::now();
        if let Some(last) = self.last_rx {
            self.max_rx_gap_ms = self.max_rx_gap_ms.max(now.duration_since(last).as_millis());
        }
        self.last_rx = Some(now);
    }
}

async fn run_socket(
    stream_id: String,
    request: http::Request<()>,
    mut receiver: mpsc::UnboundedReceiver<OutgoingFrame>,
    sink: impl SocketSink,
    registry: StreamRegistry,
) {
    // The route is the first two path segments (`/ws/voice`): enough to tell sockets apart without the session id.
    let route = request
        .uri()
        .path()
        .split('/')
        .take(3)
        .collect::<Vec<_>>()
        .join("/");
    let opened_at = Instant::now();
    diag_info!("event=ws_connecting stream_id={stream_id} route={route}");
    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, response)) => {
            diag_info!(
                "event=ws_open stream_id={stream_id} route={route} status={} ms={}",
                response.status().as_u16(),
                opened_at.elapsed().as_millis()
            );
            socket
        }
        Err(error) => {
            diag_warn!(
                "event=ws_connect_failed stream_id={stream_id} route={route} ms={} error={:?}",
                opened_at.elapsed().as_millis(),
                error.to_string().chars().take(200).collect::<String>()
            );
            sink.failed(&stream_id);
            registry
                .lock()
                .ok()
                .map(|mut streams| streams.remove(&stream_id));
            return;
        }
    };
    if !sink.opened(&stream_id) {
        diag_warn!("event=ws_closed stream_id={stream_id} cause=sink_refused_open");
        registry
            .lock()
            .ok()
            .map(|mut streams| streams.remove(&stream_id));
        return;
    }
    let (mut writer, mut reader) = socket.split();
    let mut stats = SocketStats::default();
    let mut cause = "closed_here";
    loop {
        tokio::select! {
            outgoing = receiver.recv() => match outgoing {
                Some(OutgoingFrame::Text(text)) => {
                    stats.text_tx += 1;
                    stats.bytes_tx += text.len() as u64;
                    if writer.send(Message::Text(text.into())).await.is_err() { cause = "send_failed"; break; }
                }
                Some(OutgoingFrame::Binary(bytes)) => {
                    stats.binary_tx += 1;
                    stats.bytes_tx += bytes.len() as u64;
                    if writer.send(Message::Binary(bytes.into())).await.is_err() { cause = "send_failed"; break; }
                }
                Some(OutgoingFrame::Close) | None => { let _ = writer.send(normal_close()).await; break; }
            },
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    stats.received();
                    stats.text_rx += 1;
                    stats.bytes_rx += text.len() as u64;
                    if !sink.text(&stream_id, text.to_string()) { cause = "sink_stopped"; break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    stats.received();
                    stats.binary_rx += 1;
                    stats.bytes_rx += bytes.len() as u64;
                    if !sink.binary(&stream_id, bytes.to_vec()) { cause = "sink_stopped"; break; }
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|frame| (Some(frame.code.into()), frame.reason.to_string()))
                        .unwrap_or((None, String::new()));
                    diag_info!(
                        "event=ws_close_received stream_id={stream_id} code={} reason={:?}",
                        code.map_or(-1, |code: u16| i32::from(code)),
                        reason.chars().take(64).collect::<String>()
                    );
                    sink.closed(&stream_id, code, reason);
                    cause = "remote_close";
                    break;
                }
                Some(Ok(Message::Ping(bytes))) => {
                    stats.received();
                    stats.pings_rx += 1;
                    if writer.send(Message::Pong(bytes)).await.is_err() { cause = "send_failed"; break; }
                }
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Err(error)) => {
                    diag_warn!(
                        "event=ws_read_error stream_id={stream_id} error={:?}",
                        error.to_string().chars().take(200).collect::<String>()
                    );
                    cause = "read_error";
                    break;
                }
                None => { cause = "stream_ended"; break; }
            }
        }
    }
    diag_info!(
        "event=ws_closed stream_id={stream_id} route={route} cause={cause} ms_open={} text_rx={} binary_rx={} bytes_rx={} text_tx={} binary_tx={} bytes_tx={} pings_rx={} max_rx_gap_ms={}",
        opened_at.elapsed().as_millis(),
        stats.text_rx,
        stats.binary_rx,
        stats.bytes_rx,
        stats.text_tx,
        stats.binary_tx,
        stats.bytes_tx,
        stats.pings_rx,
        stats.max_rx_gap_ms
    );
    registry
        .lock()
        .ok()
        .map(|mut streams| streams.remove(&stream_id));
    sink.closed(&stream_id, None, String::new());
}

pub fn close_origin_streams(registry: &StreamRegistry, origin: &CanonicalOrigin) {
    if let Ok(mut streams) = registry.lock() {
        let ids = streams
            .iter()
            .filter_map(|(id, open)| (open.origin == *origin).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(open) = streams.remove(&id) {
                let _ = open.sender.send(OutgoingFrame::Close);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{close_origin_streams, normal_close, OpenStream, OutgoingFrame, StreamRegistry};
    use crate::origin::CanonicalOrigin;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use tokio::sync::mpsc;

    #[test]
    fn a_close_from_this_side_is_a_normal_closure() {
        use tokio_tungstenite::tungstenite::{protocol::frame::coding::CloseCode, Message};
        match normal_close() {
            Message::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Normal),
            other => panic!("expected a close frame with a code, got {other:?}"),
        }
    }

    #[test]
    fn forgetting_one_origin_closes_only_its_streams() {
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        let (a_tx, mut a_rx) = mpsc::unbounded_channel();
        let (b_tx, mut b_rx) = mpsc::unbounded_channel();
        let registry: StreamRegistry = Arc::new(Mutex::new(HashMap::from([
            (
                "a".into(),
                OpenStream {
                    origin: a.clone(),
                    sender: a_tx,
                },
            ),
            (
                "b".into(),
                OpenStream {
                    origin: b,
                    sender: b_tx,
                },
            ),
        ])));
        close_origin_streams(&registry, &a);
        assert!(matches!(a_rx.try_recv(), Ok(OutgoingFrame::Close)));
        assert!(b_rx.try_recv().is_err());
        assert!(registry.lock().unwrap().contains_key("b"));
    }
}
