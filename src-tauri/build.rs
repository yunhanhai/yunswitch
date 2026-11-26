fn main() {
    println!("cargo:rerun-if-env-changed=YUNSWITCH_BUILD_COMMIT");
    match std::env::var("YUNSWITCH_BUILD_COMMIT") {
        Ok(commit) => {
            assert!(
                commit.len() == 40
                    && commit
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "YUNSWITCH_BUILD_COMMIT must be a full lowercase Git commit SHA"
            );
            println!("cargo:rustc-env=YUNSWITCH_BUILD_COMMIT={commit}");
        }
        Err(std::env::VarError::NotPresent) => {}
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("YUNSWITCH_BUILD_COMMIT must be a full lowercase Git commit SHA");
        }
    }
    let target = std::env::var("TARGET").expect("Cargo must provide the build target");
    println!("cargo:rustc-env=YUNSWITCH_BUILD_TARGET={target}");

    // Debug builds isolate CLI configurations from the installed application.
    // Release builds use YunSwitch's independent production data directory.
    println!("cargo:rustc-check-cfg=cfg(cc_switch_dev_build)");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-cfg=cc_switch_dev_build");
    }
    tauri_build::build();

    // Windows: Embed Common Controls v6 manifest for test binaries
    //
    // When running `cargo test`, the generated test executables don't include
    // the standard Tauri application manifest. Without Common Controls v6,
    // `tauri::test` calls fail with STATUS_ENTRYPOINT_NOT_FOUND.
    //
    // This workaround:
    // 1. Embeds the manifest into test binaries via /MANIFEST:EMBED
    // 2. Uses /MANIFEST:NO for the main binary to avoid duplicate resources
    //    (Tauri already handles manifest embedding for the app binary)
    #[cfg(target_os = "windows")]
    {
        let manifest_path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"),
        )
        .join("common-controls.manifest");
        let manifest_arg = format!("/MANIFESTINPUT:{}", manifest_path.display());

        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_arg);
        // Avoid duplicate manifest resources in binary builds.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rerun-if-changed={}", manifest_path.display());
    }
}
