package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type FileInfo struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

type FileListResponse struct {
	BucketName string     `json:"bucket_name"`
	MountPath  string     `json:"mount_path"`
	Files      []FileInfo `json:"files"`
	Total      int        `json:"total"`
}

func listFilesHandler(w http.ResponseWriter, r *http.Request) {
	bucketName := os.Getenv("BUCKET_NAME")
	if bucketName == "" {
		http.Error(w, "BUCKET_NAME environment variable not set", http.StatusInternalServerError)
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to get home directory: %v", err), http.StatusInternalServerError)
		return
	}

	mountPath := filepath.Join(home, "mnt", "r2", bucketName)

	entries, err := os.ReadDir(mountPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read directory %s: %v", mountPath, err), http.StatusInternalServerError)
		return
	}

	files := make([]FileInfo, 0, 10)
	for i, entry := range entries {
		if i >= 10 {
			break
		}

		info, err := entry.Info()
		if err != nil {
			log.Printf("Warning: could not get info for %s: %v", entry.Name(), err)
			continue
		}

		files = append(files, FileInfo{
			Name:  entry.Name(),
			IsDir: entry.IsDir(),
			Size:  info.Size(),
		})
	}

	response := FileListResponse{
		BucketName: bucketName,
		MountPath:  mountPath,
		Files:      files,
		Total:      len(entries),
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Failed to encode JSON: %v", err)
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}
}

func main() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	router := http.NewServeMux()
	router.HandleFunc("/", listFilesHandler)

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

	sig := <-stop
	log.Printf("Received signal (%s), shutting down server...", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatal(err)
	}

	log.Println("Server shutdown successfully")
}
