package types

import (
	"database/sql"
	"time"
)

var DB *sql.DB

// LogEntry is one heartbeat: an OBSERVATION that a file was being edited at an
// instant. It is deliberately not a duration. See METHODOLOGY.md.
type LogEntry struct {
	FileName  string    `bson:"name"`
	Project   string    `bson:"project"`
	TimeStamp time.Time `bson:"timestamp"`
	Date      string    `bson:"date"`
	Language  string    `bson:"language"`
	Os        string    `bson:"os"`
	GitBranch string    `bson:"gitBranch"`
	Editor    string    `bson:"editor"`

	// ConfigVersion identifies which tracker config regime produced this heartbeat,
	// so the query-time algorithm can resolve the throttle interval without guessing.
	// Must match an entry in the config registry (analytics/duration.mjs + the
	// `configs` collection). omitempty keeps it off records written before v3.
	ConfigVersion int `bson:"configVersion,omitempty"`

	// Duration is RETIRED as of config regime v3 (2026-08-09) and is never written
	// any more. It only ever held the throttle interval frozen at write time, which
	// made it an interpretation baked into the raw log rather than a measurement —
	// and it silently went wrong whenever the throttle changed.
	//
	// The field survives here purely so that pre-v3 records still round-trip through
	// the offline SQLite queue. omitempty means a zero value is omitted from the
	// BSON document entirely, so new heartbeats carry no `duration` key at all.
	//
	// DO NOT SUM THIS FIELD. Use analytics/duration.mjs.
	Duration float64 `bson:"duration,omitempty"`
}

type StatItem struct {
	Name       string
	Duration   float64
	Percentage float64
}

// --- Config & Colors ---
const (
	TopN     = 4
	BarWidth = 10
	Reset    = "\033[0m"
	Bold     = "\033[1m"
	Green    = "\033[32m"
	Cyan     = "\033[36m"
	Gray     = "\033[90m"
)

type Stat struct {
	Name     string
	Duration float64
	Percent  float64
}

// LanguageStat holds the data for a single row
type LanguageStat struct {
	Name    string
	Time    string
	Percent float64 // 0.0 to 1.0
	Color   string  // Hex code
}

// Global configuration constants for easy tweaking
const (
	CanvasWidth  = 800
	CanvasHeight = 500
	BgColor      = "#0d1117" // GitHub Dark Dimmed
	TextColor    = "#ffffff"
	SubTextColor = "#8b949e"
	BarBgColor   = "#30363d"
)

type UploadStruct struct {
	Token     string
	Owner     string
	Repo      string
	Path      string // e.g. "public/stats.png"
	Branch    string // e.g. "main"
	CommitMsg string
}

type ListStats struct {
	Label   string
	Value   string
	Percent float64
	Color   string
}

type TimeGridStruct struct {
	Yestarday string
	Week      string
	Month     string
	AllTime   string
}

type ThemeConfig struct {
	BackgroundColor    string
	TextColor          string
	SubTextColor       string
	BarBackgroundColor string

	// Palette for graphs/bars
	Color1 string // Primary (Cyan/Blue)
	Color2 string // Secondary (Green)
	Color3 string // Tertiary (Yellow/Orange)
	Color4 string // Quaternary (Red/Purple)
}

func DefaultTheme() ThemeConfig {
	return ThemeConfig{
		BackgroundColor:    "#0d1117", // GitHub Dark Dimmed
		TextColor:          "#ffffff",
		SubTextColor:       "#8b949e",
		BarBackgroundColor: "#30363d",
		Color1:             "#58a6ff", // Blue
		Color2:             "#2ea043", // Green
		Color3:             "#e3b341", // Gold
		Color4:             "#f78166", // Red
	}
}

//coding hours distribution

type ActivityDistribution struct {
	Morning   float64 // 06:00 - 12:00
	Afternoon float64 // 12:00 - 18:00
	Evening   float64 // 18:00 - 24:00
	Night     float64 // 00:00 - 06:00
	MaxVal    float64 // The highest of the four
}

// cache for dashborad
type CacheData struct {
	Languages    []ListStats          `json:"languages"`
	Projects     []ListStats          `json:"projects"`
	OS           []ListStats          `json:"os"`
	Editors      []ListStats          `json:"editors"`
	TimeStats    TimeGridStruct       `json:"timeStats"`
	Activity     ActivityDistribution `json:"activity"`
	Streak       int                  `json:"streak"`
	TodayHours   float64              `json:"today_hours"`
	AverageHours float64              `json:"average_hours"`
	DailyHistory map[string]float64   `json:"daily_history"`
	Theme        string               `json:"theme"`
}

//all avaliable themes

var AvailableThemes = []string{
	"default", "light", "dracula", "nord", "gruvbox", "monokai",
	"cyberpunk", "tokyonight", "everforest", "iceberg", "sunset",
	"deepocean", "midnight", "catppuccin", "solarized", "onedark",
	"material", "synthwave",
}
