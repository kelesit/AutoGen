import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
export const SCHEMA_VERSION = 102;
export function transact(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "playbox.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === SCHEMA_VERSION) return db;
    if (version === 100 || version === 101) {
      transact(db, () => {
        const lockedVersion = db.prepare("PRAGMA user_version").get().user_version;
        if (lockedVersion === SCHEMA_VERSION) return;
        if (lockedVersion !== 100 && lockedVersion !== 101)
          throw new Error("开发数据库版本在升级期间发生了变化。");
        if (lockedVersion === 100) {
          db.exec("ALTER TABLE templates ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
          db.exec("UPDATE templates SET tags=json_array(category) WHERE trim(category)<>''");
        }
        db.exec("ALTER TABLE jobs ADD COLUMN accepted_at INTEGER");
        db.exec(`UPDATE jobs SET accepted_at=(
          SELECT MIN(created_at) FROM job_events
          WHERE job_id=jobs.id AND kind IN ('accepted','reconciled')
        ) WHERE provider_id IS NOT NULL`);
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      return db;
    }
    if (
      version !== 0 ||
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .get()
    )
      throw new Error("开发数据库版本不匹配。请使用新的 DATA_DIR；本版本不迁移旧 demo 数据。");
    transact(db, () =>
      db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')),credits INTEGER NOT NULL CHECK(credits>=0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0),created_at INTEGER NOT NULL);
      CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
      CREATE TABLE assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('image','reference','preview','output')),
        filename TEXT UNIQUE NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('staging','ready','deleting','deleted')),
        library INTEGER NOT NULL DEFAULT 0 CHECK(library IN (0,1)),created_at INTEGER NOT NULL,
        expires_at INTEGER,deleted_at INTEGER,cleanup_error TEXT);
      CREATE TABLE templates(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,
        description TEXT NOT NULL,category TEXT NOT NULL,tags TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL CHECK(status IN ('public','private','deleted')),
        current_version_id TEXT REFERENCES template_versions(id),preview_asset_id TEXT REFERENCES assets(id),
        create_key TEXT NOT NULL,create_payload TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        published_at INTEGER,UNIQUE(owner_id,create_key));
      CREATE TABLE template_versions(id TEXT PRIMARY KEY,template_id TEXT NOT NULL REFERENCES templates(id),
        version INTEGER NOT NULL,input_schema TEXT NOT NULL,prompt_recipe TEXT NOT NULL,output_options TEXT NOT NULL,
        created_at INTEGER NOT NULL,UNIQUE(template_id,version));
      CREATE TABLE template_version_assets(version_id TEXT NOT NULL REFERENCES template_versions(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),position INTEGER NOT NULL,PRIMARY KEY(version_id,position),UNIQUE(version_id,asset_id));
      CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),template_id TEXT NOT NULL REFERENCES templates(id),
        template_version_id TEXT NOT NULL REFERENCES template_versions(id),
        prompt TEXT NOT NULL,resolution TEXT NOT NULL,duration INTEGER NOT NULL,cost INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','submitting','submission_unknown','running','persisting','needs_review','completed','failed','cancelled')),
        progress INTEGER NOT NULL DEFAULT 0,error TEXT,request_key TEXT NOT NULL,created_at INTEGER NOT NULL,accepted_at INTEGER,completed_at INTEGER,
        billing_state TEXT NOT NULL CHECK(billing_state IN ('held','settled','released')),scenario TEXT NOT NULL,
        provider_id TEXT,template_snapshot TEXT NOT NULL,quote_snapshot TEXT NOT NULL,retries INTEGER NOT NULL DEFAULT 0,
        review_phase TEXT,input_digest TEXT,input_assets_snapshot TEXT NOT NULL,UNIQUE(user_id,request_key));
      CREATE TABLE job_input_assets(job_id TEXT NOT NULL REFERENCES jobs(id),asset_id TEXT NOT NULL REFERENCES assets(id),
        slot_key TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('image','reference')),PRIMARY KEY(job_id,role,slot_key));
      CREATE TABLE job_outputs(job_id TEXT PRIMARY KEY REFERENCES jobs(id),asset_id TEXT UNIQUE NOT NULL REFERENCES assets(id));
      CREATE TABLE creations(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),user_id TEXT NOT NULL REFERENCES users(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),created_at INTEGER NOT NULL,deleted_at INTEGER);
      CREATE TABLE ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),job_id TEXT REFERENCES jobs(id),
        kind TEXT NOT NULL,amount INTEGER NOT NULL,reserved_delta INTEGER NOT NULL DEFAULT 0,description TEXT NOT NULL,
        created_at INTEGER NOT NULL,UNIQUE(job_id,kind));
      CREATE TABLE favorites(user_id TEXT NOT NULL REFERENCES users(id),template_id TEXT NOT NULL REFERENCES templates(id),PRIMARY KEY(user_id,template_id));
      CREATE TABLE work(job_id TEXT PRIMARY KEY REFERENCES jobs(id),due_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),kind TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE provider_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE provider_costs(job_id TEXT PRIMARY KEY REFERENCES jobs(id),provider_id TEXT UNIQUE NOT NULL,cost_units INTEGER NOT NULL,unit TEXT NOT NULL DEFAULT 'mock_units',created_at INTEGER NOT NULL);
      CREATE TABLE runtime(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT INTO runtime VALUES ('heartbeat',0),('paused_until',0),('consecutive_errors',0);
      CREATE INDEX jobs_user_created ON jobs(user_id,created_at DESC);
      CREATE INDEX jobs_status ON jobs(status);
      CREATE INDEX creations_user_created ON creations(user_id,deleted_at,created_at DESC);
      CREATE INDEX template_assets_asset ON template_version_assets(asset_id);
      CREATE INDEX job_assets_asset ON job_input_assets(asset_id);
      CREATE INDEX assets_cleanup ON assets(state,library,expires_at);
      CREATE INDEX events_job ON job_events(job_id,id);
      CREATE INDEX ledger_user_created ON ledger(user_id,created_at DESC);
      PRAGMA user_version=${SCHEMA_VERSION};
    `),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
