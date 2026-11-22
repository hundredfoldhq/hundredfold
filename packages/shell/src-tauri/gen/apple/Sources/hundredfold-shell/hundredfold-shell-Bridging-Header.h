#ifndef hundredfold_shell_Bridging_Header_h
#define hundredfold_shell_Bridging_Header_h

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Implemented in Rust (src/ios.rs); called by the native voice client in
// voice/VoiceController.swift.
void hf_voice_on_capture(const uint8_t *bytes, size_t length);
void hf_voice_on_onset(int64_t segment_id, int64_t played_ms);
void hf_voice_on_played(uint32_t segment_id);
void hf_voice_on_stop(const char *reason);
void hf_voice_on_interruption(bool began, uint64_t suspended_ms);

#endif
