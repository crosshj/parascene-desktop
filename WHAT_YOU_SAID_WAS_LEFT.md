# What was left — current status

The desktop implementation and the server integration are in place, but the
work is not yet equivalent to a fully signed-off production release. The
remaining work is validation, not the core project-folder model.

## Still outstanding

1. **Live capability detection.** The desktop client currently assumes the new
   server contract. The contract is deployed and verified, so this is not a
   current deployment blocker, but a capability/version check would make mixed
   deployments safer.

2. **Real legacy-profile testing.** Open copies of representative profiles and
   verify all-root assets, one-folder assets, previously bound projects,
   mixed-folder assets, missing files, composition-heavy projects, and an
   interrupted migration.

3. **Cross-client and failure testing.** Exercise old and new clients against
   the deployed server, including conflicts, retries, crashes between SQLite
   and localStorage writes, and partial sync failures.

4. **Manual Tauri acceptance.** Exercise create, rename, reopen, Library
   management of closed projects, blocked deletion, generation/import,
   composition cleanup, locked remote project folders, and recovery/error
   messages in the actual app.

5. **Observation-period cleanup.** Legacy JSON fields, compatibility commands,
   and the queued-operation adapter have no current UI writers, but should be
   removed only after the observation period confirms that old data and clients
   no longer require them.

6. **Final release checks.** Run the complete repository checks, review the
   resulting diff, and commit the verified change. No commit has been made yet.

## Practical completion strategy

With limited quota, the efficient path is to avoid broad refactoring and use a
focused verification pass:

1. Run only the highest-value automated checks that have not already been run.
2. Inspect the implementation against each outstanding item above.
3. Perform the smallest useful manual Tauri smoke test, if the app can be
   launched in the current environment.
4. Record any concrete failures, fix only those, rerun affected checks, and
   then commit without pushing.

The accurate label is therefore: **desktop implementation complete; server
integration complete; release validation and compatibility testing remain.**
