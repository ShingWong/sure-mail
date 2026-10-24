// E1 for D19 (engine-agnostic storage): can Turso Database — the pure-Rust,
// SQLite-compatible engine — build AND RUN as a wasm32-wasip2 component?
//
// It opens a real database file, creates a table, inserts, and reads back —
// the smallest thing that proves the storage path end to end, including the
// filesystem access a database needs.
//
//   cargo build --release --target wasm32-wasip2
//   wasmtime run -S cli=y --dir .::/ target/wasm32-wasip2/release/turso-wasi-probe.wasm probe.db
//
// Turso's API is async and wasm32-wasip2 has no threads, so it runs on a
// single-threaded executor (futures::executor::block_on).

use futures::executor::block_on;
use turso::Builder;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "probe.db".to_string());
    println!("turso-wasi-probe: opening {path}");

    let result = block_on(async {
        let db = Builder::new_local(&path).build().await?;
        let conn = db.connect()?;
        conn.execute("CREATE TABLE IF NOT EXISTS probe(a INTEGER, b TEXT)", ())
            .await?;
        conn.execute("INSERT INTO probe VALUES (1, 'hello from wasi')", ())
            .await?;
        let mut rows = conn.query("SELECT a, b FROM probe", ()).await?;
        let mut out: Vec<String> = Vec::new();
        while let Some(row) = rows.next().await? {
            let a: i64 = row.get(0)?;
            let b: String = row.get(1)?;
            out.push(format!("{a} / {b}"));
        }
        Ok::<Vec<String>, turso::Error>(out)
    });

    match result {
        Ok(rows) => {
            println!("turso on wasm32-wasip2 OK — {} row(s)", rows.len());
            for r in rows {
                println!("  row: {r}");
            }
        }
        Err(e) => {
            eprintln!("turso failed: {e}");
            std::process::exit(1);
        }
    }
}
