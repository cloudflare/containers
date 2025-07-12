use actix_web::{web, App, HttpServer, Responder};
use std::env;

async fn handler() -> impl Responder {
    let message = env::var("MESSAGE")
        .unwrap_or_else(|_| "🦀 I was passed in via the container class!".to_string());
    let instance_id = env::var("CLOUDFLARE_DEPLOYMENT_ID").unwrap_or_else(|_| "local".to_string());
    format!(
        "🦀 Hi, I'm a container and this is my message: \"{}\", my instance ID is: {}",
        message, instance_id
    )
}

async fn error_handler() -> impl Responder {
    // This handler is intended to panic, but we must return a type that
    // implements Responder. We will never actually return this response.
    panic!("This is a panic");
    #[allow(unreachable_code)]
    Ok::<_, actix_web::Error>(())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .route("/error", web::get().to(error_handler))
            .default_service(web::to(handler))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}
