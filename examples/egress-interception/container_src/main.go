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

	if p := r.URL.Query().Get("proxy"); p != "" {
		res, err := http.Get("http://" + p)
		if err != nil {
			w.WriteHeader(520)
			io.WriteString(w, "error connecting to proxy: "+err.Error())
			return
		}

		fmt.Println("Let's go.", res.StatusCode)

		w.WriteHeader(res.StatusCode)
		body, err := io.ReadAll(res.Body)
		if err != nil {
			w.WriteHeader(520)
			io.WriteString(w, "error connecting to proxy: "+err.Error())
			return
		}

		w.Write(body)
		return
	}

	fmt.Fprintf(w, "Hi, I'm a container and this is my message: %s, and my deployment ID is: %s", message, deploymentId)
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
