package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func handler(w http.ResponseWriter, r *http.Request) {
	message := os.Getenv("MESSAGE")
	deploymentId := os.Getenv("CLOUDFLARE_DEPLOYMENT_ID")

	fmt.Fprintf(w, "Hi, I'm a container and this is my message: %s, and my deployment ID is: %s", message, deploymentId)
}

// Makes an outbound request to the origin specified in the ?origin= query param.
// Traffic is intercepted by the outbound Worker defined in the DO class.
func egressHandler(w http.ResponseWriter, r *http.Request) {
	origin := r.URL.Query().Get("origin")
	if origin == "" {
		http.Error(w, "missing ?origin= query parameter", http.StatusBadRequest)
		return
	}

	resp, err := http.Get(origin)
	if err != nil {
		http.Error(w, fmt.Sprintf("egress request failed: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func errorHandler(w http.ResponseWriter, r *http.Request) {
	// panics
	panic("This is a panic")
}

func main() {
	stop := make(chan os.Signal, 1)

	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	router := http.NewServeMux()
	router.HandleFunc("/", handler)
	router.HandleFunc("/container", handler)
	router.HandleFunc("/egress", egressHandler)
	router.HandleFunc("/error", errorHandler)

	server := &http.Server{
		Addr:    ":8080",
		Handler: router,
	}

	go func() {
		log.Printf("Server listening on %s\n", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-stop
	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatal(err)
	}

	log.Println("Server shutdown successfully")
}
