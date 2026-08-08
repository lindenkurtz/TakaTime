package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lindenkurtz/TakaTime/internal/types"
	_ "modernc.org/sqlite"
)

func InitSQLite() (*sql.DB, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	dbDir := filepath.Join(home, ".takatime")
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		return nil, err
	}

	dbPath := filepath.Join(dbDir, "taka.db")

	// Open the DB connection
	sqliteDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}

	// Create table
	query := `
    CREATE TABLE IF NOT EXISTS offline_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
		CREATE TABLE IF NOT EXISTS dashboard_cache (
		id TEXT PRIMARY KEY,
		data TEXT,
		updated_at DATETIME
	);
	CREATE TABLE IF NOT EXISTS config (
		id INTEGER PRIMARY KEY,
		config TEXT,
		timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
	);`

	if _, err := sqliteDB.Exec(query); err != nil {
		return nil, err
	}

	// Return the active connection
	return sqliteDB, nil
}

func Enqueue(entry types.LogEntry, db *sql.DB) error {
	jsonData, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO offline_logs (data) VALUES (?)", string(jsonData))
	return err
}

func Flush(uploadFunc func(batch []types.LogEntry) error, db *sql.DB) bool {
	// 1. Fetch oldest 50 logs
	rows, err := db.Query("SELECT id, data FROM offline_logs ORDER BY id ASC LIMIT 50")
	if err != nil {
		log.Printf("SQLite Read Error: %v", err)
		return false
	}
	defer rows.Close()

	var batch []types.LogEntry
	var ids []int

	for rows.Next() {
		var id int
		var rawJSON string
		if err := rows.Scan(&id, &rawJSON); err == nil {
			var entry types.LogEntry
			if json.Unmarshal([]byte(rawJSON), &entry) == nil {
				batch = append(batch, entry)
				ids = append(ids, id)
			}
		}
	}

	// If queue is empty, we are done!
	if len(batch) == 0 {
		return false
	}

	// 2. ATTEMPT UPLOAD (Critical Step)
	log.Printf("Attempting to sync %d logs...", len(batch))
	err = uploadFunc(batch)

	if err != nil {
		// FAIL: Keep data, stop processing
		log.Printf("Upload failed (Data kept safely offline): %v", err)
		return false // Stop loop
	}

	// 3. SUCCESS: Delete these specific IDs
	deleteBatch(ids, db)
	log.Printf("Synced & Cleaned %d logs.", len(batch))

	// Return true to say "We processed a batch, maybe check if there is more?"
	return true
}

func deleteBatch(ids []int, db *sql.DB) {
	if len(ids) == 0 {
		return
	}

	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf("DELETE FROM offline_logs WHERE id IN (%s)", strings.Join(placeholders, ","))
	_, err := db.Exec(query, args...)
	if err != nil {
		log.Printf("Failed to delete synced logs: %v", err)
	}
}

func SyncQueue(mongoURI string, db *sql.DB) {
	for {
		// Flush calls our closure for every batch of 50 logs
		moreData := Flush(func(batch []types.LogEntry) error {
			return AddEntryToMongo(batch, mongoURI)
		}, db)

		if !moreData {
			break // Queue is empty or sync failed (loop stops)
		}
	}
}

// SaveDashboardCache overwrites the 'main' cache row with fresh data
func SaveDashboardCache(db *sql.DB, data types.CacheData) error {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}

	// INSERT OR REPLACE ensures we never have duplicate rows.
	// It just overwrites the 'main' ID every time.
	query := `INSERT OR REPLACE INTO dashboard_cache (id, data, updated_at) VALUES ('main', ?, ?)`
	_, err = db.Exec(query, string(jsonData), time.Now())
	return err
}

// GetDashboardCache checks if data exists and is less than 5 minutes old
func GetDashboardCache(db *sql.DB) (*types.CacheData, error) {
	var rawJSON string
	var updatedAt time.Time

	// Fetch the single 'main' row
	err := db.QueryRow("SELECT data, updated_at FROM dashboard_cache WHERE id = 'main'").Scan(&rawJSON, &updatedAt)
	if err != nil {
		return nil, err // Will return error if no cache exists yet
	}

	//  THE 5-MINUTE RULE
	if time.Since(updatedAt) > 5*time.Minute {
		return nil, fmt.Errorf("cache expired") // Force a fresh fetch
	}

	// Unmarshal the valid cache
	var cache types.CacheData
	if err := json.Unmarshal([]byte(rawJSON), &cache); err != nil {
		return nil, err
	}

	return &cache, nil
}

//local theme save !!!

// Save the Config (Uses ID 1 so it always overwrites the same row)
func SaveConfig(db *sql.DB, config types.CacheData) error {
	configJSON, err := json.Marshal(config)
	if err != nil {
		return err
	}

	query := `
	INSERT OR REPLACE INTO config (id, config, timestamp) 
	VALUES (1, ?, CURRENT_TIMESTAMP);`

	_, err = db.Exec(query, string(configJSON))
	return err
}

// 3. Load the Config
func LoadConfig(db *sql.DB) (types.CacheData, error) {
	var configStr string
	var conf types.CacheData

	// Grab row ID 1
	err := db.QueryRow(`SELECT config FROM config WHERE id = 1`).Scan(&configStr)
	if err != nil {
		if err == sql.ErrNoRows {
			// If no config exists yet, return a default!
			return types.CacheData{Theme: "sunset"}, nil
		}
		return conf, err
	}

	// Unmarshal the JSON string back into our struct
	err = json.Unmarshal([]byte(configStr), &conf)
	return conf, err
}
