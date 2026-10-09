// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    {
        let arg = "--disable-direct-composition-video-overlays";
        let new_args = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) => {
                if existing.contains(arg) {
                    existing
                } else {
                    format!("{existing} {arg}")
                }
            }
            Err(_) => arg.to_string(),
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", new_args);
    }

    taurivideoplayer_lib::run()
}
