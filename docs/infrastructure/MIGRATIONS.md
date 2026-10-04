# Infrastructure and data migrations

Every migration follows discover, back up, copy, verify, cut over, monitor, and retain-source stages.

For database extraction, compare table counts, foreign-key integrity, critical record hashes, and immutable IDs. Use a durable mapping table when IDs change. Never delete source tables during the first cutover pass.

For object storage, inventory and copy objects, verify counts and hashes where possible, switch reads before writes when safe, then retain old storage through the rollback window.

Production migrations require a current backup and a tested restore path. Stop before any plan containing an unexpected destroy, database replacement, volume deletion, or guessed secret.
