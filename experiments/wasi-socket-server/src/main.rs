// Minimal WASI socket server — the feasibility probe for D17's universal
// host: can one artifact listen/accept, dial out, and resolve names, with
// the runtime supplying sockets (and, later, TLS)?
//
// Plain Rust std on purpose. No sockets crate, no wit-bindgen, no TLS stack:
// if this runs, the *runtime* is doing the network work, which is the whole
// point (the guest stays portable and small).
//
//   wasi-socket-server listen  <addr>            echo server (accept + echo)
//   wasi-socket-server connect <addr> [message]  dial out, send, read reply
//
// Build:  cargo build --release --target wasm32-wasip2
// Run:    wasmtime run -S cli=y -S tcp=y -S allow-ip-name-lookup=y \
//           target/wasm32-wasip2/release/wasi-socket-server.wasm listen 127.0.0.1:9100

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("listen") => listen(args.get(1).map(String::as_str).unwrap_or("127.0.0.1:9100")),
        Some("connect") => connect(
            args.get(1).map(String::as_str).expect("connect <addr> [message]"),
            args.get(2).map(String::as_str).unwrap_or("ping\n"),
        ),
        other => {
            eprintln!("unknown mode {other:?}");
            eprintln!("usage: wasi-socket-server <listen <addr>|connect <addr> [message]>");
            std::process::exit(2);
        }
    }
}

/// Accept connections and echo them back — proves listen + accept + read/write.
fn listen(addr: &str) {
    let listener = match TcpListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind {addr} failed: {e}");
            std::process::exit(1);
        }
    };
    println!("listening on {addr}");
    for stream in listener.incoming() {
        match stream {
            Ok(mut s) => {
                println!("accepted {:?}", s.peer_addr().ok());
                let mut buf = [0u8; 4096];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if s.write_all(&buf[..n]).is_err() {
                                break;
                            }
                            let _ = s.flush();
                        }
                        Err(e) => {
                            eprintln!("read failed: {e}");
                            break;
                        }
                    }
                }
                println!("closed");
            }
            Err(e) => eprintln!("accept failed: {e}"),
        }
    }
}

/// Dial a host:port, send, half-close, print the reply — proves outbound
/// connect, and (with a hostname) `wasi:sockets/ip-name-lookup`.
fn connect(addr: &str, message: &str) {
    let mut s = match TcpStream::connect(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("connect {addr} failed: {e}");
            std::process::exit(1);
        }
    };
    println!("connected to {addr}");
    if let Err(e) = s.write_all(message.as_bytes()) {
        eprintln!("write failed: {e}");
        std::process::exit(1);
    }
    let _ = s.flush();
    let _ = s.shutdown(Shutdown::Write);
    let mut reply = String::new();
    let _ = s.read_to_string(&mut reply);
    println!("reply: {}", reply.trim_end());
}
