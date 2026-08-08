package main

import (
	"flag"
	"fmt"
	"log"
	"path/filepath"
	"time"

	utils "github.com/lindenkurtz/TakaTime/internal/Utils"
	"github.com/lindenkurtz/TakaTime/internal/db"
	"github.com/lindenkurtz/TakaTime/internal/debugger"
	"github.com/lindenkurtz/TakaTime/internal/types"
)

// pes2ug23cs645
func main() {

	uri := flag.String("uri", "", "MongoDB Atlas Connection URI")
	project := flag.String("project", "unknown", "Project Name")
	file := flag.String("file", "", "File Name")
	language := flag.String("language", "unknown", "Lnaguage")
	editor := flag.String("editor", "unknown", "Editor Name NeoVim/VsCode")
	configVersion := flag.Int("configVersion", 0, "Tracker config regime that produced this heartbeat")
	versionFlag := flag.Bool("version", false, "show Version")

	// DEPRECATED. Accepted so that older plugins still run against this binary, but
	// the value is discarded: a heartbeat records an observation, not a duration.
	// Durations are computed at query time from timestamps. See METHODOLOGY.md.
	duration := flag.Float64("duration", 0, "DEPRECATED — ignored; durations are derived at query time")

	flag.Parse()

	if *versionFlag {
		fmt.Println(types.Version)
		return
	}

	if *duration > 0 {
		log.Printf("Ignoring deprecated -duration=%v; durations are computed at query time.", *duration)
	}

	if *uri == "" {
		log.Fatalln("Argument -uri is required (MongoDB connection URI)")
		return
	}

	// -configVersion is OPTIONAL on purpose.
	//
	// Callers spawn this process fire-and-forget with stdio discarded, so a
	// log.Fatalln here would be silent data loss rather than a visible error.
	// Requiring the flag would turn any misconfigured caller into lost heartbeats.
	//
	// When absent, `omitempty` leaves configVersion off the document entirely and the
	// query-time algorithm resolves the interval by date instead, reporting the
	// heartbeat as estimated — strictly better than dropping the data.
	// See METHODOLOGY.md.
	if *configVersion <= 0 {
		log.Printf("No -configVersion given; heartbeat will be stored unstamped and interpreted by date.")
	}

	//setup debugger logs
	err := debugger.SetupLog()

	if err != nil {
		log.Panic("Failed to initialize logger: ", err)
	}

	var errr error
	types.DB, errr = db.InitSQLite()
	if err != nil {
		log.Fatal("Could not initialize local DB:", errr)
	}
	defer types.DB.Close()

	// ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	// defer cancel()
	//
	// client, err := db.ConnectToDataBase(*uri)
	// if err != nil {
	// 	log.Fatalln("Counld not connect to mongo db", err)
	// }
	//
	// collection := client.Database("takatime").Collection("logs")
	//
	fileDir := filepath.Dir(*file)

	gitBranch, err := utils.GetGitBranch(fileDir)
	if err != nil {
		log.Printf("Could not get git branch there might not be one or initiated yet !! %s", err)
		gitBranch = ""
	}

	// Duration is intentionally not set — it is retired as of config regime v3, and
	// `omitempty` keeps the key off the document entirely. `timestamp` is the record.
	entry := types.LogEntry{
		FileName:      *file,
		Project:       *project,
		TimeStamp:     time.Now(),
		Date:          time.Now().Format("2006-01-02"),
		Language:      *language,
		Os:            utils.GetOS(),
		GitBranch:     gitBranch,
		Editor:        *editor,
		ConfigVersion: *configVersion,
	}

	// _, err = collection.InsertOne(ctx, entry)

	// 6. STEP 1: Always Save to Local DB First (Safety Net)
	if err := db.Enqueue(entry, types.DB); err != nil {
		log.Printf("Failed to save offline: %v", err)
		// If we can't save to disk, we probably shouldn't continue
		return
	}
	log.Printf("Saved log for '%s' to offline queue.", *file)

	// 7. STEP 2: The Sync Loop (Drain the Queue)
	// We assume *uri is valid here. If empty, we just skip syncing.
	if *uri != "" {
		db.SyncQueue(*uri, types.DB)
	}

	// if err != nil {
	// 	log.Fatal("Insert Failed:", err)
	// }
	//
	// log.Println("Log processed sucessfullty")
}
