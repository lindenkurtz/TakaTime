package main

import (
	"time"

	"github.com/lindenkurtz/TakaTime/internal/Styles"
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
)

type Model struct {
	Loading bool
	Err     error

	//mongo uri
	MongoURI string

	//data model
	LanguageListStats []types.ListStats
	ProjectListStats  []types.ListStats
	OsListStats       []types.ListStats
	editorListStats   []types.ListStats
	TimeStats         types.TimeGridStruct

	//default theme
	TUITheme types.ThemeConfig

	AppStyles Styles.AppStyles

	//last DB QUery
	DataFetchedTime time.Time

	//cache bool to nofify if it is from cache
	CacheData    bool
	TodayHours   float64
	ActivityData types.ActivityDistribution
	Streak       int
	AverageHours float64
	DailyHistory map[string]float64

	// bacis responsive vars
	Width    int
	Height   int
	Viewport viewport.Model
	Ready    bool

	//viewMore bool
	ViewMore bool

	//spinner
	Spinner spinner.Model

	//active tabs
	ActiveTab string

	//settings Model
	SettingsCursor int
	ShowSettings   bool
}
