package main

import (
	"github.com/lindenkurtz/TakaTime/internal/Styles"
	utils "github.com/lindenkurtz/TakaTime/internal/Utils"
	"github.com/lindenkurtz/TakaTime/internal/db"
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type dataLoadedMsg struct {
	updatedModel Model
	err          error
	FromCache    bool
}

func fetchData(uri string) tea.Cmd {
	return func() tea.Msg {
		// Initialize SQLite connection
		sqliteDB, err := db.InitSQLite()
		if err != nil {
			// Fallback if DB fails to open
			return dataLoadedMsg{updatedModel: Model{}, err: err}
		}
		defer sqliteDB.Close()

		// 👉 NEW 1: Load the Config and Compile the Styles
		var loadedStyles Styles.AppStyles
		userConfig, err := db.LoadConfig(sqliteDB)

		if err == nil && userConfig.Theme != "" {
			// We found a saved theme! Compile it.
			loadedStyles = Styles.BuildStyles(utils.ThemeSwitcher(userConfig.Theme))
		} else {
			// No saved config yet? Default to sunset!
			loadedStyles = Styles.BuildStyles(utils.ThemeSwitcher("sunset"))
		}

		// Check Cache First
		cachedData, err := db.GetDashboardCache(sqliteDB)
		if err == nil && cachedData != nil {
			// Cache HIT
			tempModel := Model{
				AppStyles:         loadedStyles, // 👉 NEW 2: Attach styles to the Cache HIT model
				LanguageListStats: cachedData.Languages,
				ProjectListStats:  cachedData.Projects,
				OsListStats:       cachedData.OS,
				editorListStats:   cachedData.Editors,
				TimeStats:         cachedData.TimeStats,
				ActivityData:      cachedData.Activity,
				Streak:            cachedData.Streak,
				TodayHours:        cachedData.TodayHours,
				AverageHours:      cachedData.AverageHours,
				DailyHistory:      cachedData.DailyHistory,
			}
			return dataLoadedMsg{updatedModel: tempModel, err: nil, FromCache: true}
		}

		// Cache MISS! Fetch fresh from MongoDB
		tempModel := Model{}
		filledModel, _, err := tempModel.GetData(uri)

		// 👉 NEW 3: Attach styles to the Cache MISS model before returning it
		filledModel.AppStyles = loadedStyles

		if err != nil {
			return dataLoadedMsg{updatedModel: filledModel, err: err}
		}

		// Save to SQLite Cache for next time
		if sqliteDB != nil {
			db.SaveDashboardCache(sqliteDB, types.CacheData{
				Languages:    filledModel.LanguageListStats,
				Projects:     filledModel.ProjectListStats,
				OS:           filledModel.OsListStats,
				Editors:      filledModel.editorListStats,
				TimeStats:    filledModel.TimeStats,
				Activity:     filledModel.ActivityData,
				Streak:       filledModel.Streak,
				TodayHours:   filledModel.TodayHours,
				AverageHours: filledModel.AverageHours,
				DailyHistory: filledModel.DailyHistory,
			})
		}

		return dataLoadedMsg{
			updatedModel: filledModel,
			err:          nil,
			FromCache:    false,
		}
	}
}

// updateViewport swaps the content based on the active tab
func (m *Model) updateViewport() {
	if m.ActiveTab == "about" {
		m.Viewport.SetContent(m.generateAboutContent())
	} else {
		m.Viewport.SetContent(m.generateScrollableContent())
	}
}

// ----------------------------
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var (
		cmd  tea.Cmd
		cmds []tea.Cmd
	)

	switch msg := msg.(type) {

	//spinner

	case spinner.TickMsg:
		var spinCmd tea.Cmd
		m.Spinner, spinCmd = m.Spinner.Update(msg)
		cmds = append(cmds, spinCmd)

		// If we are still loading, return immediately so the UI repaints the new frame
		if m.Loading {
			return m, tea.Batch(cmds...)
		}

		return m, cmd

	case tea.WindowSizeMsg:
		// Save the raw dimensions
		m.Width = msg.Width
		m.Height = msg.Height

		// We know our Header is roughly 3 lines, and Footer is 3 lines.
		// So the vertical margin we need to subtract from the viewport is 6.
		headerHeight := 6
		footerHeight := 3
		verticalMargin := headerHeight + footerHeight

		if !m.Ready {
			// 1. Initialize the viewport on the first render
			m.Viewport = viewport.New(msg.Width, msg.Height-verticalMargin)
			m.Viewport.YPosition = headerHeight                  // Start it below the header
			m.Viewport.SetContent(m.generateScrollableContent()) // Helper func we will write
			m.Ready = true
		} else {
			// 2. If already ready, just resize it
			m.Viewport.Width = msg.Width
			m.Viewport.Height = msg.Height - verticalMargin
			// m.Viewport.SetContent(m.updateViewport())
		}
		m.updateViewport()
		return m, nil

	case dataLoadedMsg:
		m.Loading = false
		m.CacheData = msg.FromCache
		m.AppStyles = msg.updatedModel.AppStyles

		//  ASSIGN THE DATA HERE!
		if msg.err == nil {
			m.LanguageListStats = msg.updatedModel.LanguageListStats
			m.ProjectListStats = msg.updatedModel.ProjectListStats
			m.OsListStats = msg.updatedModel.OsListStats
			m.editorListStats = msg.updatedModel.editorListStats
			m.TimeStats = msg.updatedModel.TimeStats
			m.ActivityData = msg.updatedModel.ActivityData
			m.Streak = msg.updatedModel.Streak
			m.TodayHours = msg.updatedModel.TodayHours
			m.DailyHistory = msg.updatedModel.DailyHistory
		}

		// 3. Update the viewport content now that we have data!
		if m.Ready {
			// m.Viewport.SetContent(m.generateScrollableContent())
			m.updateViewport()
		}
		return m, nil

	case tea.KeyMsg:

		//settings model
		if m.ShowSettings {
			switch msg.String() {
			case "esc", "q", "s", "S":
				m.ShowSettings = false // Close modal without saving

			// Navigation (Supports wrapping around columns!)
			case "up", "k":
				if m.SettingsCursor > 1 {
					m.SettingsCursor -= 2
				} // Jump up a row
			case "down", "j":
				if m.SettingsCursor < len(types.AvailableThemes)-2 {
					m.SettingsCursor += 2
				} // Jump down a row
			case "left", "h":
				if m.SettingsCursor > 0 {
					m.SettingsCursor--
				} // Move left
			case "right", "l":
				if m.SettingsCursor < len(types.AvailableThemes)-1 {
					m.SettingsCursor++
				} // Move right

			case "enter":
				// 1. Grab the name of the selected theme
				selectedThemeName := types.AvailableThemes[m.SettingsCursor]

				// 2. Fetch the new color palette using your function
				newThemeConfig := utils.ThemeSwitcher(selectedThemeName)

				// 3. Rebuild the AppStyles using the new colors!
				// (Replace `Styles.BuildStyles` with whatever function you use to initialize styles)
				m.AppStyles = Styles.BuildStyles(newThemeConfig)

				// 4. Close the modal to reveal the new theme!

				sqliteDB, _ := db.InitSQLite()
				if sqliteDB != nil {
					// Assuming AppConfig is in your types package
					db.SaveConfig(sqliteDB, types.CacheData{Theme: selectedThemeName})
					sqliteDB.Close()
				}

				// 3. Rebuild the AppStyles locally using the new colors
				m.AppStyles = Styles.BuildStyles(newThemeConfig)
				m.ShowSettings = false

				// 4. Force the viewport to redraw with the new colors!
				if m.Ready {
					m.updateViewport()
				}
			}
			m.Loading = true
			return m, fetchData(m.MongoURI)
		}

		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		case "r":
			m.Loading = true
			return m, fetchData(m.MongoURI)

		case "m":
			// Toggle the boolean (True becomes False, False becomes True)
			m.ViewMore = !m.ViewMore

			// Recalculate the viewport content with the new size!
			if m.Ready {
				// m.Viewport.SetContent(m.generateScrollableContent())
				m.updateViewport()
			}
			return m, nil

		case "h", "H":
			if m.ActiveTab != "home" {
				m.ActiveTab = "home"
				m.Viewport.GotoTop() // Reset scroll position when switching tabs
				m.updateViewport()
			}
			return m, nil

		case "a", "A":
			if m.ActiveTab != "about" {
				m.ActiveTab = "about"
				m.Viewport.GotoTop() // Reset scroll position when switching tabs
				m.updateViewport()
			}
			return m, nil

		case "s", "S": //  ADD THE HOTKEY TO OPEN SETTINGS!
			m.ShowSettings = true
			m.SettingsCursor = 0 // Reset cursor to top
			return m, nil

		}
	}

	// 4. Pass ANY unhandled messages (like scrolling keys) to the viewport!
	if m.Ready {
		m.Viewport, cmd = m.Viewport.Update(msg)
		cmds = append(cmds, cmd)
	}

	return m, tea.Batch(cmds...)
}
