# Human local restart walkthrough

This is a synthetic local setup check. Your choice records a decision; it does not run a migration or change another repository. Human acceptance remains pending until you report what you observed.

## Start

Use the Node version qualified with the installed SQLite native module (currently Node 24.22.1) and Bun 1.4.5. From the Who-Decides checkout:

```sh
export LOCAL_PROOF_BUN="$(command -v bun)"
npm run local:start -- /absolute/path/to/chopin
```

Leave this foreground terminal open. The default data directory is `.tmp/private-local`. Use the same directory on every restart. See [setup](private-local-setup.md) for builds, credentials and OS restrictions.

In another terminal in Who-Decides, prepare the synthetic request:

```sh
node scripts/private-local-walkthrough.mjs prepare
```

This command is repeatable after success: it returns the same request instead of creating another. It never submits an operator answer. An interrupted intake with an unknown outcome stops for inspection rather than automatically sending again. Do not delete its marker to bypass that check.

## Check while pending

1. Open <http://127.0.0.1:18798>, choose **Continue locally**, and sign in as `operator` using `.tmp/private-local/chopin-passcode.txt`.
2. Open <http://127.0.0.1:13100> and sign in using `.tmp/private-local/operator-passcode.txt`. Read these local files yourself; do not paste the passcodes into chat.
3. Find **May the synthetic worker continue after this local restart check?** Verify its two options are approve/reject synthetic continuation. Leave it unanswered.
4. Stop the supervisor with Ctrl-C, then rerun the same start command. Refresh both pages. Confirm the same pending question remains.

## Decide and restart

5. In Who-Decides, choose either option and enter a short rationale. Submit once. Confirm the decision is recorded and its delivery is confirmed. If delivery is unknown, record that state rather than treating it as successful.
6. Run the read-only check in the second terminal:

```sh
node scripts/private-local-walkthrough.mjs status
```

7. Stop and restart the supervisor again. Refresh the pages and run `status` again. Confirm the same question ID and answer survive. The script deliberately keeps human acceptance pending; only your observations establish that acceptance.
8. Stop with Ctrl-C when finished. Keep the data directory for the evidence trail.

## Report back

- Pending question survived restart: yes/no.
- Choice and rationale recorded: yes/no; which choice.
- Delivery state shown: confirmed/unknown/failed.
- Same answer survived the second restart: yes/no.
- Anything confusing or unexpected in the UI.

The seeded walkthrough uses a dedicated local data directory. Do not reset the console or reuse it for another run during this check. For a fresh independent walkthrough, start the supervisor with a new data-directory argument and pass that same directory to `prepare` and `status`.
