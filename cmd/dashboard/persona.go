package main

import (
	"fmt"
	"strings"
	"time"

	persnalization "github.com/lindenkurtz/TakaTime/internal/Persnalization"
	"github.com/lindenkurtz/TakaTime/internal/Styles"
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

func buildActiveTimeBox(dist types.ActivityDistribution, styles Styles.AppStyles, width int) string {
	var b strings.Builder

	persona := persnalization.GetCoderPersona(dist)
	titleStyle := lipgloss.NewStyle().Bold(true).Width(width).Align(lipgloss.Center).MarginBottom(1)
	b.WriteString(titleStyle.Render(fmt.Sprintf("━ %s ━", persona)) + "\n")

	// Calculate the total sum of all hours for the percentage math
	totalTime := dist.Morning + dist.Afternoon + dist.Evening + dist.Night

	drawRow := func(label string, value float64, max float64) string {
		barWidth := width - 26
		if barWidth < 5 {
			barWidth = 5
		}
		if barWidth > 20 {
			barWidth = 20
		}

		// Progress bar math
		percentOfMax := 0.0
		if max > 0 {
			percentOfMax = value / max
		}

		filledCount := int(percentOfMax * float64(barWidth))
		if filledCount > barWidth {
			filledCount = barWidth
		}

		filledBar := styles.Color1.Render(strings.Repeat("█", filledCount))
		emptyBar := styles.SubText.Render(strings.Repeat("░", barWidth-filledCount))

		//  Text math
		percentageOfTotal := 0.0
		if totalTime > 0 {
			percentageOfTotal = (value / totalTime) * 100
		}

		timeStr := styles.ListPercent.Render(fmt.Sprintf("%4.1f%%", percentageOfTotal))
		labelStr := styles.ListLabel.Render(fmt.Sprintf("%-10s", label))

		return fmt.Sprintf("%s | %s%s | %s\n", labelStr, filledBar, emptyBar, timeStr)
	}

	// Group all the rows into a single text block
	var rowsBlock strings.Builder
	rowsBlock.WriteString(drawRow("Morning", dist.Morning, dist.MaxVal))
	rowsBlock.WriteString(drawRow("Afternoon", dist.Afternoon, dist.MaxVal))
	rowsBlock.WriteString(drawRow("Evening", dist.Evening, dist.MaxVal))
	rowsBlock.WriteString(drawRow("Night", dist.Night, dist.MaxVal))

	//center all
	centeredRows := lipgloss.NewStyle().
		Width(width).
		Align(lipgloss.Center).
		Render(rowsBlock.String())

	b.WriteString(centeredRows)

	return styles.Box.Width(width).Render(b.String())
}

// --------------------------------------------------------------------------------------------

// heatmap

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++


func BuildHeatmapBox(history map[string]float64, styles Styles.AppStyles, width int) string {
	var b strings.Builder

	titleStyle := lipgloss.NewStyle().Bold(true).Width(width).Align(lipgloss.Center).MarginBottom(1)
	b.WriteString(titleStyle.Render("━ 365-Day Contribution Graph ━") + "\n\n")

	today := time.Now()
	start := today.AddDate(0, 0, -364)
	offset := int(start.Weekday())
	curr := start.AddDate(0, 0, -offset)

	var weekCols []string
	var monthForWeek []string
	var lastMonth time.Month = 0

	// 1. Build the grid strictly column by column (Week by Week)
	for !curr.After(today) {
		var currentWeekDays []string

		// Track months for the header row
		if curr.Month() != lastMonth {
			monthForWeek = append(monthForWeek, curr.Format("Jan"))
			lastMonth = curr.Month()
		} else {
			monthForWeek = append(monthForWeek, "")
		}

		// Build the 7 vertical days for this specific week
		for i := 0; i < 7; i++ {
			if curr.Before(start) || curr.After(today) {
				currentWeekDays = append(currentWeekDays, " ") // Invisible padding
			} else {
				dateStr := curr.Format("2006-01-02")
				val := history[dateStr]

				// Notice I upgraded your colors here so the intensity pops!
				char := styles.SubText.Render("░") // 0 hours
				if val > 0 && val <= 1.0 {
					char = styles.Color1.Render("▒") // Light
				} else if val > 1.0 && val <= 3.0 {
					char = styles.Color2.Render("▓") // Solid
				} else if val > 3.0 {
					char = styles.Color3.Render("█") // Heavy!
				}
				currentWeekDays = append(currentWeekDays, char)
			}
			curr = curr.AddDate(0, 0, 1)
		}

		// Snap the 7 days together vertically into one solid column block
		weekCol := lipgloss.JoinVertical(lipgloss.Center, currentWeekDays...)
		
		// Add exactly 1 space of margin to the right of the column to space out the weeks
		weekColStyled := lipgloss.NewStyle().MarginRight(1).Render(weekCol)
		weekCols = append(weekCols, weekColStyled)
	}

	// 2. Snap all 52 week columns together side-by-side!
	heatmapGrid := lipgloss.JoinHorizontal(lipgloss.Top, weekCols...)

	// 3. Build the Month Header safely matching the column widths
	var headerBuilder strings.Builder
	skip := 0
	for _, month := range monthForWeek {
		if skip > 0 {
			skip--
			continue
		}
		if month != "" {
			// A week column is 2 chars wide (char + margin). "Apr " is 4 chars, fitting perfectly over 2 weeks.
			headerBuilder.WriteString(fmt.Sprintf("%-4s", month)) 
			skip = 1 // Skip the next column's label slot so we don't overlap
		} else {
			headerBuilder.WriteString("  ") // 2 spaces for an empty column
		}
	}
	monthHeader := styles.SubText.Render(headerBuilder.String())

	// 4. Build the Y-Axis Labels (Mon, Wed, Fri) as a separate block
	yAxis := lipgloss.JoinVertical(lipgloss.Right,
		"   ", // Sun
		"Mon", // Mon
		"   ", // Tue
		"Wed", // Wed
		"   ", // Thu
		"Fri", // Fri
		"   ", // Sat
	)
	// Add a 1-character margin to separate the labels from the grid
	yAxisStyled := lipgloss.NewStyle().MarginRight(1).Render(styles.SubText.Render(yAxis))

	// 5. Assemble everything into a final layout
	// Join the Y-Axis and the Grid
	mainBody := lipgloss.JoinHorizontal(lipgloss.Top, yAxisStyled, heatmapGrid)

	// Align the Month Header by offsetting it by the width of the Y-Axis (3 chars + 1 margin = 4 spaces)
	alignedHeader := lipgloss.NewStyle().MarginLeft(4).Render(monthHeader)

	// Stack the Header on top of the main grid body
	finalChart := lipgloss.JoinVertical(lipgloss.Left, alignedHeader, mainBody)

	// 6. Center the entire flawlessly aligned block inside the terminal width
	centeredChart := lipgloss.Place(width, lipgloss.Height(finalChart), lipgloss.Center, lipgloss.Center, finalChart)
	b.WriteString(centeredChart + "\n")

	// 7. Render Legend
	legend := fmt.Sprintf("Less %s %s %s %s More",
		styles.SubText.Render("░"),
		styles.Color1.Render("▒"),
		styles.Color2.Render("▓"),
		styles.Color3.Render("█"))

	legendStyled := lipgloss.NewStyle().Width(width).Align(lipgloss.Center).MarginTop(1).Render(legend)
	b.WriteString(legendStyled)

	return styles.Box.Width(width).Render(b.String())
}
