package main

import (
	"fmt"
	"strings"

	persnalization "github.com/lindenkurtz/TakaTime/internal/Persnalization"
	"github.com/lindenkurtz/TakaTime/internal/Styles"
	utils "github.com/lindenkurtz/TakaTime/internal/Utils"
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

// Add 'showAll bool' to the end of the parameters
func buildStatsList(title string, stats []types.ListStats, styles Styles.AppStyles, width int, showAll bool) string {
	var cleanStats []types.ListStats
	for _, stat := range stats {
		if strings.ToLower(stat.Label) != "unknown" {
			cleanStats = append(cleanStats, stat)
		}
	}
	stats = cleanStats
	if len(stats) == 0 {
		return ""
	}

	var b strings.Builder
	// b.WriteString(styles.SubText.Render(fmt.Sprintf("--- %s ---", title)) + "\n")
	// 1. Create a prominent, centered style dynamically based on the box width
	titleStyle := lipgloss.NewStyle().
		Bold(true).             // Make it thick
		Width(width).           // Stretch it to the exact width of the box
		Align(lipgloss.Center). // Perfectly center the text inside that width
		MarginBottom(1)         // Add a blank line below it for breathing room

	// 2. Format the string (Uppercase makes it feel "bigger" and more important)
	formattedTitle := fmt.Sprintf("━ %s ━", strings.ToUpper(title))

	// 3. Render and write it to the builder
	b.WriteString(titleStyle.Render(formattedTitle) + "\n")
	// 1. Determine which stats to show
	limit := 10

	displayStats := stats
	hiddenCount := 0

	// 2. Safely check and slice using the exact same variable
	if !showAll && len(stats) > limit {
		displayStats = stats[:limit]
		hiddenCount = len(stats) - limit
	}
	var rowsBlock strings.Builder

	barWidth := 15

	// 2. Loop through the SLICED array
	// 2. Loop through the SLICED array
	for _, stat := range displayStats {
		// 1. Truncate long names, then PAD short names to exactly 12 characters (Left-Aligned)
		safeLabel := utils.SafeTruncateString(stat.Label, 10)
		paddedLabel := utils.SafePadText(safeLabel, 12, false)
		label := styles.ListLabel.Render(paddedLabel)

		// 2. PAD short times to exactly 8 characters (Right-Aligned so the "m" and "h" line up)
		paddedValue := utils.SafePadText(stat.Value, 8, true)
		value := styles.ListValue.Render(paddedValue)

		percentStr := styles.ListPercent.Render(fmt.Sprintf("%8.1f%%", stat.Percent*100))

		filledCount := int(stat.Percent * float64(barWidth))
		if filledCount > barWidth {
			filledCount = barWidth
		}

		filledBar := styles.Color2.Render(strings.Repeat("█", filledCount))
		emptyBar := styles.SubText.Render(strings.Repeat("░", barWidth-filledCount))
		visualBar := filledBar + emptyBar

		rowsBlock.WriteString(fmt.Sprintf("%s | %s | %s %s\n\n", label, value, visualBar, percentStr))
	} // 3. Add the "See More" text if we are hiding things
	if hiddenCount > 0 {
		indicator := fmt.Sprintf("... and %d more (press 'm')", hiddenCount)
		// Right-align or center the indicator for a clean look
		rowsBlock.WriteString(styles.SubText.Render(indicator) + "\n")
	}

	// blockHeight := lipgloss.Height(rowsBlock.String())
	// centeredRows := lipgloss.Place(width, blockHeight, lipgloss.Center, lipgloss.Top, rowsBlock.String())
	blockHeight := lipgloss.Height(rowsBlock.String())

	// 1. Force the internal text to lock to the left
	leftAlignedText := lipgloss.NewStyle().Align(lipgloss.Left).Render(rowsBlock.String())

	// 2. Place that locked block in the center of the box
	finalRows := lipgloss.Place(width, blockHeight, lipgloss.Center, lipgloss.Top, leftAlignedText)
	// b.WriteString(centeredRows)
	b.WriteString(finalRows)

	return styles.Box.Width(width).Render(b.String())
}

// buildTimeGrid creates a row of 4 horizontal cards for your summary stats
func buildTimeGrid(data types.TimeGridStruct, styles Styles.AppStyles, width int) string {
	// 1. Determine Layout & Calculate Exact Math
	var cardWidth int
	var columns int
	gap := 2 // 2 spaces between cards

	if width >= 80 {
		columns = 4
		// Math: (Total Width - (3 gaps * 2 spaces)) / 4 cards
		cardWidth = (width - (3 * gap)) / 4
	} else if width >= 45 {
		columns = 2
		// Math: (Total Width - 1 gap) / 2 cards
		cardWidth = (width - gap) / 2
	} else {
		columns = 1
		cardWidth = width
	}

	// 2. Helper function to build a single card safely
	buildCard := func(title, value string) string {
		titleBlock := styles.StatCardTitle.Render(title)
		valueBlock := styles.StatCardValue.Render(value)
		content := lipgloss.JoinVertical(lipgloss.Center, titleBlock, valueBlock)

		// Enforcing MaxWidth is the secret to stopping border blowouts!
		return styles.StatCard.Copy().
			Width(cardWidth).
			MaxWidth(cardWidth).
			Align(lipgloss.Center).
			Render(content)
	}

	yesterday := buildCard("Yesterday", data.Yestarday)
	week := buildCard("7 Days", data.Week)
	month := buildCard("30 Days", data.Month)
	allTime := buildCard("All Time", data.AllTime)

	// 3. Create a mathematical spacer block instead of raw string spaces
	spacer := lipgloss.NewStyle().Width(gap).Render("")

	// 4. Render the layout using the strict spacers
	switch columns {
	case 4:
		// Wide screen: All in one row
		row := lipgloss.JoinHorizontal(lipgloss.Top, yesterday, spacer, week, spacer, month, spacer, allTime)

		// Force the entire row to center inside the designated terminal width
		return lipgloss.Place(width, lipgloss.Height(row), lipgloss.Center, lipgloss.Center, row)

	case 2:
		// Medium screen: 2x2 Grid
		row1 := lipgloss.JoinHorizontal(lipgloss.Top, yesterday, spacer, week)
		row2 := lipgloss.JoinHorizontal(lipgloss.Top, month, spacer, allTime)

		grid := lipgloss.JoinVertical(lipgloss.Left, row1, "\n", row2)
		return lipgloss.Place(width, lipgloss.Height(grid), lipgloss.Center, lipgloss.Center, grid)

	default:
		// Small screen: Stacked vertically
		return lipgloss.JoinVertical(lipgloss.Left, yesterday, "\n", week, "\n", month, "\n", allTime)
	}
}

func (m Model) generateScrollableContent() string {
	if m.Loading {
		loadingText := fmt.Sprintf("%s %s",
			m.Spinner.View(),
			m.AppStyles.SubText.Render("Fetching your coding stats..."),
		)
		return lipgloss.Place(
			m.Viewport.Width, m.Viewport.Height,
			lipgloss.Center, lipgloss.Center,
			loadingText,
		)
	}

	var b strings.Builder
	contentWidth := m.Viewport.Width - 4
	if contentWidth < 40 {
		contentWidth = 40
	}

	if m.CacheData {
		b.WriteString(m.AppStyles.SubText.Render("⚡ Loaded from local cache") + "\n\n")
	}

	b.WriteString(buildTimeGrid(m.TimeStats, m.AppStyles, contentWidth))
	b.WriteString("\n\n")

	// 2. The Gamification Row (Split 50/50)
	halfWidth := (contentWidth / 2) - 1

	var maxHours float64
	var maxDate string
	for date, hours := range m.DailyHistory {
		if hours > maxHours {
			maxHours = hours
			maxDate = date
		}
	}
	// A new box for Today's specific goal/streak
	streakBox := persnalization.BuildStreakBox(m.Streak, m.TodayHours, m.AverageHours, maxHours, maxDate, m.AppStyles, halfWidth)
	activeTimeBox := buildActiveTimeBox(m.ActivityData, m.AppStyles, halfWidth)

	gamificationRow := lipgloss.JoinHorizontal(lipgloss.Top, streakBox, "  ", activeTimeBox)
	b.WriteString(gamificationRow + "\n\n")
	//heatmap like github
	heatmapBox := BuildHeatmapBox(m.DailyHistory, m.AppStyles, contentWidth)
	b.WriteString(heatmapBox + "\n\n")

	lanuagesBlock := buildStatsList("Languages", m.LanguageListStats, m.AppStyles, halfWidth, m.ViewMore)
	projectsBlock := buildStatsList("Projects", m.ProjectListStats, m.AppStyles, halfWidth, m.ViewMore)

	flexRowLanguageAndProjects := lipgloss.JoinHorizontal(lipgloss.Top, lanuagesBlock, " ", projectsBlock)
	b.WriteString(flexRowLanguageAndProjects + "\n")
	osBox := buildStatsList("Operating Systems", m.OsListStats, m.AppStyles, halfWidth, m.ViewMore)
	editorBox := buildStatsList("Editors", m.editorListStats, m.AppStyles, halfWidth, m.ViewMore)

	flexRow := lipgloss.JoinHorizontal(lipgloss.Top, osBox, "  ", editorBox)
	b.WriteString(flexRow + "\n")

	// Center the whole block
	return lipgloss.NewStyle().
		Width(m.Viewport.Width).
		Align(lipgloss.Center).
		Render(b.String())
}
