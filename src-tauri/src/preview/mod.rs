//! Rust-owned virtual timeline preview → fMP4 fragments for MSE.

mod cache;
mod compose;
mod fmp4;
mod protocol;
mod remux;
mod session;
mod timeline;

pub use protocol::preview_response;
pub use session::{
    preview_get_state, preview_pause, preview_play, preview_read_fragment, preview_seek,
    preview_session_close, preview_session_open, preview_set_rate, preview_set_timeline,
};
