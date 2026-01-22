use axum::{Router, response::IntoResponse, routing::get};
use tokio::signal;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use std::env;
use std::io;
use std::net::SocketAddr;

async fn handler() -> impl IntoResponse {
    debug!("Handler called");
    let message = env::var("MESSAGE").unwrap_or_default();
    let instance_id = env::var("CLOUDFLARE_DURABLE_OBJECT_ID").unwrap_or_default();

    format!(
        "Hi, I'm a container and this is my message: \"{}\", my instance ID is: {}",
        message, instance_id
    )
}

async fn error_handler() -> impl IntoResponse {
    panic!("This is a panic") as ()
}

#[tokio::main]
async fn main() -> io::Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "debug".into()),
        )
        .with(tracing_subscriber::fmt::layer().with_ansi(false))
        .init();

    // Build our application with routes
    let app = Router::new()
        .route("/", get(handler))
        .route("/container", get(handler))
        .route("/error", get(error_handler))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http());

    // Define the address to listen on
    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    info!("Server listening on {}", addr);

    // Run the server with graceful shutdown
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Server shutdown successfully");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            warn!("Received SIGINT, shutting down server...");
        },
        _ = terminate => {
            warn!("Received SIGTERM, shutting down server...");
        },
    }
}
