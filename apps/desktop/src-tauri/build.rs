fn main() {
    tauri_build::build();

    // `tauri_build` only embeds the Common-Controls v6 manifest on `bin` targets,
    // so the `[lib]` test harness fails at load time resolving `TaskDialogIndirect`
    // from `comctl32.dll` (`0xc0000139`). Delay-loading lets non-dialog unit tests run.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-lib=delayimp");
        // Suppress MSVC LNK4199 on targets like the bin test harness where
        // dead-code elimination removes all `comctl32.dll` imports.
        println!("cargo:rustc-link-arg=/IGNORE:4199");
    }
}
