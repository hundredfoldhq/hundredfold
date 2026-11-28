//! The bundled Hundredfold shell shared by desktop, iOS, and Android.

#[cfg(target_os = "android")]
mod android;
mod commands;
mod credentials;
mod deep_link;
#[cfg(desktop)]
mod display;
#[cfg(target_os = "ios")]
mod ios;
#[cfg(desktop)]
mod menu;
mod navigation;
mod origin;
#[cfg(desktop)]
mod probe;
mod stream;
mod voice;
mod workspace_state;

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;
use tauri::{
    utils::config::WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";

const BRIDGE_SCRIPT: &str = r#"
(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || window.__HUNDREDFOLD_NATIVE__) return;
  class Channel {
    constructor(onmessage) {
      this.id = internals.transformCallback((event) => {
        if (Object.prototype.hasOwnProperty.call(event, 'message')) onmessage(event.message);
        if (Object.prototype.hasOwnProperty.call(event, 'end')) internals.unregisterCallback(this.id);
      });
    }
    toJSON() { return `__CHANNEL__:${this.id}`; }
  }
  const invoke = (command, input) => internals.invoke(command, { input });
  Object.defineProperty(window, '__HUNDREDFOLD_NATIVE__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      runtime: 'tauri',
      pair: (input) => invoke('pair', input),
      request: (input) => invoke('request', input),
      stream: (input, onEvent) => {
        const on_event = new Channel(onEvent);
        return internals.invoke('stream', { input, onEvent: on_event });
      },
      forget: (input) => invoke('forget', input),
      readWorkspaceState: () => internals.invoke('workspace_state_read', {}),
      writeWorkspaceState: (input) => invoke('workspace_state_write', input),
      /*voice*/
    }),
  });
})();
"#;

/// The native voice entries. Mobile only: the web client picks the native voice session
/// whenever `voiceStart` exists, and the desktop shell has no native audio, so it must
/// leave the browser path in charge there.
#[cfg(mobile)]
const VOICE_METHODS: &str = r#"voiceStart: (input, onFrame) => {
        const on_event = new Channel(onFrame);
        return internals.invoke('voice_start', { input, onEvent: on_event });
      },
      voiceStop: () => internals.invoke('voice_stop', {}),
      voicePtt: (input) => invoke('voice_ptt', input),
      voiceStatus: () => internals.invoke('voice_status', {}),"#;
#[cfg(not(mobile))]
const VOICE_METHODS: &str = "";

fn bridge_script() -> String {
    BRIDGE_SCRIPT.replace("/*voice*/", VOICE_METHODS)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let native_state =
        commands::NativeState::new().expect("the native gateway client could not be initialized");
    let builder = tauri::Builder::default()
        .manage(native_state)
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::pair,
        commands::request,
        stream::stream,
        commands::forget,
        workspace_state::workspace_state_read,
        workspace_state::workspace_state_write,
        voice::voice_start,
        voice::voice_stop,
        voice::voice_ptt,
        voice::voice_status,
        probe::report
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::pair,
        commands::request,
        stream::stream,
        commands::forget,
        workspace_state::workspace_state_read,
        workspace_state::workspace_state_write,
        voice::voice_start,
        voice::voice_stop,
        voice::voice_ptt,
        voice::voice_status
    ]);

    builder
        .on_page_load(|window, payload| {
            #[cfg(desktop)]
            match payload.event() {
                PageLoadEvent::Started => display::announce_refresh_rate(window),
                PageLoadEvent::Finished if window.label() == probe::LABEL => probe::run(window),
                PageLoadEvent::Finished => {}
            }
            #[cfg(mobile)]
            let _ = (window, payload);
        })
        .setup(|app| {
            let navigation_handle = app.handle().clone();
            let popup_handle = app.handle().clone();
            let builder =
                WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                    .title("Hundredfold");
            // Fixed sizes are desktop-only: on iOS the window frame is taken from them, so a
            // 1280x860 request lays the page out far wider than the phone screen.
            #[cfg(desktop)]
            let builder = builder
                .inner_size(1280.0, 860.0)
                .min_inner_size(390.0, 480.0);
            let window = builder
                .initialization_script(bridge_script())
                .on_navigation(move |url| match navigation::decide(url) {
                    navigation::NavigationDecision::Local => true,
                    navigation::NavigationDecision::External => {
                        let _ = navigation_handle
                            .opener()
                            .open_url(url.as_str(), None::<&str>);
                        false
                    }
                    navigation::NavigationDecision::Deny => false,
                })
                .on_new_window(move |url, _| {
                    if navigation::decide(&url) == navigation::NavigationDecision::External {
                        let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            #[cfg(desktop)]
            {
                menu::install(app.handle(), &window)?;
                if probe::requested() {
                    probe::open(app.handle())?;
                }
            }
            deep_link::route_into(app.handle(), window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Hundredfold shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::bridge_script;

    #[test]
    fn the_bridge_exposes_voice_on_mobile_only() {
        let script = bridge_script();
        assert!(
            script.contains("stream:"),
            "the common entries are always there"
        );
        assert_eq!(script.contains("voiceStart"), cfg!(mobile));
        assert_eq!(script.contains("voiceStatus"), cfg!(mobile));
        assert!(!script.contains("/*voice*/"));
    }
}
