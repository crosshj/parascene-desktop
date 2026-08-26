//! In-process preview encode scheduler — not the catalog `jobs.rs` FIFO.
//!
//! Caps concurrent FFmpeg fragment encodes and fences stale results when a slot
//! is re-requested with a new fingerprint before the prior bake finishes.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_CONCURRENT_BAKES: usize = 2;
const BAKE_SLOT_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PreviewBakeSlot {
    pub project_id: String,
    pub index: u32,
}

#[derive(Clone, Debug)]
struct SlotState {
    fingerprint: String,
    generation: u64,
}

struct SchedulerState {
    active: usize,
    slots: HashMap<PreviewBakeSlot, SlotState>,
}

struct Scheduler {
    state: Mutex<SchedulerState>,
    available: Condvar,
}

static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();

fn scheduler() -> &'static Scheduler {
    SCHEDULER.get_or_init(|| Scheduler {
        state: Mutex::new(SchedulerState {
            active: 0,
            slots: HashMap::new(),
        }),
        available: Condvar::new(),
    })
}

pub struct PreviewBakeGuard {
    slot: PreviewBakeSlot,
    generation: u64,
    released: bool,
}

impl PreviewBakeGuard {
    pub fn is_stale(&self) -> bool {
        let guard = scheduler()
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .slots
            .get(&self.slot)
            .map(|slot| slot.generation != self.generation)
            .unwrap_or(true)
    }
}

impl Drop for PreviewBakeGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let sched = scheduler();
        let mut guard = sched
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.active = guard.active.saturating_sub(1);
        drop(guard);
        sched.available.notify_one();
    }
}

/// Wait for a bake slot and register this fingerprint generation.
pub fn acquire_preview_bake_slot(
    project_id: &str,
    index: u32,
    fingerprint: &str,
) -> Result<PreviewBakeGuard, String> {
    let sched = scheduler();
    let slot = PreviewBakeSlot {
        project_id: project_id.trim().to_string(),
        index,
    };
    let fingerprint = fingerprint.trim().to_string();
    if slot.project_id.is_empty() || fingerprint.is_empty() {
        return Err("Invalid preview bake slot".into());
    }

    let mut guard = sched
        .state
        .lock()
        .map_err(|_| "Preview scheduler unavailable".to_string())?;
    let deadline = Instant::now() + BAKE_SLOT_WAIT;
    while guard.active >= MAX_CONCURRENT_BAKES {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Preview bake queue timed out".into());
        }
        guard = sched
            .available
            .wait_timeout(guard, remaining)
            .map_err(|_| "Preview scheduler unavailable".to_string())?
            .0;
        if Instant::now() >= deadline {
            return Err("Preview bake queue timed out".into());
        }
    }

    guard.active += 1;
    let entry = guard.slots.entry(slot.clone()).or_insert(SlotState {
        fingerprint: fingerprint.clone(),
        generation: 0,
    });
    if entry.fingerprint != fingerprint {
        entry.fingerprint = fingerprint;
        entry.generation = entry.generation.saturating_add(1);
    }
    let generation = entry.generation;
    Ok(PreviewBakeGuard {
        slot,
        generation,
        released: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_fence_when_fingerprint_changes() {
        let slot = PreviewBakeSlot {
            project_id: "p-test".into(),
            index: 99,
        };
        let g1 = acquire_preview_bake_slot(&slot.project_id, slot.index, "fp-a").expect("slot");
        {
            let mut guard = scheduler()
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard.slots.get_mut(&slot).expect("slot state");
            entry.fingerprint = "fp-b".into();
            entry.generation += 1;
        }
        assert!(g1.is_stale());
        drop(g1);
    }
}
