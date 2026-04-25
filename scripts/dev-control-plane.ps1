$env:RUST_BINARY = "..\rust-core\target\debug\rust-core.exe"
npx --prefix ..\control-plane tsx src/index.ts
