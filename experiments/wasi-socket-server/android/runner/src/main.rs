// Minimal wasmtime embedder for the WASI 0.2 socket-server component.
//
// It is the embedding counterpart of `wasmtime run -S cli=y -S tcp=y
// -S allow-ip-name-lookup=y -S inherit-network=y`: it builds a WasiCtx with
// TCP, UDP, DNS and inherited network enabled, then runs a `wasi:cli/command`
// component synchronously. Same crate versions as the wasmtime CLI that is
// proven on Linux and Windows, so one runtime covers all three hosts.
//
//   wasi-runner <component.wasm> [guest-args...]
//
// Built for x86_64-linux-android and pushed to /data/local/tmp on the emulator.

use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store};
use wasmtime_wasi::p2::bindings::sync::Command;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

struct Ctx {
    wasi: WasiCtx,
    table: ResourceTable,
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

fn main() -> Result<()> {
    // argv[0] is the component path, exactly as `wasmtime run` presents it to
    // the guest, so the guest's own `args().skip(1)` sees the real arguments.
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let wasm = args
        .first()
        .expect("usage: wasi-runner <component.wasm> [guest-args...]");

    let mut config = Config::new();
    config.wasm_component_model(true);
    let engine = Engine::new(&config)?;

    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;

    let component = Component::from_file(&engine, wasm)?;

    let mut builder = WasiCtx::builder();
    builder
        .inherit_stdio()
        .inherit_env()
        .args(&args)
        .allow_tcp(true)
        .allow_udp(true)
        .allow_ip_name_lookup(true)
        .inherit_network();
    let mut store = Store::new(
        &engine,
        Ctx {
            wasi: builder.build(),
            table: ResourceTable::new(),
        },
    );

    let command = Command::instantiate(&mut store, &component, &linker)?;
    match command.wasi_cli_run().call_run(&mut store) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(())) => std::process::exit(1),
        // A guest `proc_exit(code)` arrives as a trap; surface its code.
        Err(e) => {
            let code = e.downcast_ref::<wasmtime_wasi::I32Exit>().map(|x| x.0);
            match code {
                Some(code) => std::process::exit(code),
                None => Err(e),
            }
        }
    }
}
