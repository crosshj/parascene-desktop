//! Parascene Blue direct — Settings credentials, Lab capabilities, runs, local history.
//! Hits the Blue generation server (default https://blue.parascene.com) with user Blue
//! credentials; outputs land local-only (no Parascene Creation). See docs/PLAN-parascene-blue-direct.md.

mod client;
mod commands;
mod credentials;
mod history;
pub(crate) mod run;

pub use commands::*;
