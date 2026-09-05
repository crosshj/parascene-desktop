//! Direct Replicate API domain — catalog crawl/cache, token, allowlist, Lab runs.
//! All network + catalog coordination lives here; the FE only invokes and renders.

mod cache;
mod client;
mod commands;
mod enabled_models;
mod features;
mod files;
mod history;
mod jobs;
pub(crate) mod predict;
mod schema_page;
mod token;

pub use commands::*;

/// Drop per-account Replicate memory when the bound user folder changes.
pub(crate) fn reset_account_memory() {
    enabled_models::reset_memory();
    cache::reset_index_memory();
}
