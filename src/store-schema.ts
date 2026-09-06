export const CONSUMPTION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS consumption_receipts (
    decision_id TEXT PRIMARY KEY,
    receipt_json TEXT NOT NULL,
    successor_invocation_id TEXT NOT NULL,
    decision_digest TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  )
`

export const LOCAL_OWNER_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS local_owner_slots (
    issuer_id TEXT NOT NULL, decision_id TEXT NOT NULL, decision_digest TEXT NOT NULL,
    claim_digest TEXT, claim_session TEXT, decision_status_head TEXT, claim_status_head TEXT,
    start_intent_digest TEXT, PRIMARY KEY (issuer_id, decision_id));
  CREATE TABLE IF NOT EXISTS local_owner_records (
    issuer_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, decision_id TEXT NOT NULL,
    digest TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (issuer_id, kind, record_id));
  CREATE TABLE IF NOT EXISTS local_owner_status (
    issuer_id TEXT NOT NULL, decision_id TEXT NOT NULL, target_kind TEXT NOT NULL,
    sequence INTEGER NOT NULL, digest TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY (issuer_id, decision_id, target_kind, sequence));
  CREATE TABLE IF NOT EXISTS local_owner_clock (issuer_id TEXT PRIMARY KEY, wall_time TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS local_owner_human_acts (
    issuer_id TEXT NOT NULL, event_ref TEXT NOT NULL, packet_ref TEXT NOT NULL,
    digest TEXT NOT NULL, record_json TEXT NOT NULL, used_by_decision TEXT,
    PRIMARY KEY (issuer_id, event_ref), UNIQUE (issuer_id, packet_ref));
`
