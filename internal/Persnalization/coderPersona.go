package persnalization

import (
	"fmt"
	"strings"
	"time"

	"github.com/lindenkurtz/TakaTime/internal/Styles"
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

func GetCoderPersona(dist types.ActivityDistribution) string {
	max := dist.Morning
	title := "🌅  Early Bird"

	if dist.Afternoon > max {
		max = dist.Afternoon
		title = "☀️  Afternoon Architect"
	}
	if dist.Evening > max {
		max = dist.Evening
		title = "🌆  Evening Engineer"
	}
	if dist.Night > max {
		title = "🦉  Midnight Vampire"
	}

	// Fun fallback if they haven't coded at all
	if dist.Morning == 0 && dist.Afternoon == 0 && dist.Evening == 0 && dist.Night == 0 {
		return "💤 Resting Developer"
	}

	return title
}

// buildStreakBox creates a gamified widget showing the user's streak and daily goal progress
func BuildStreakBox(streak int, todayHours float64, avgHours float64, maxHours float64, maxDate string, styles Styles.AppStyles, width int) string {
	var b strings.Builder

	// Render the Header
	titleStyle := lipgloss.NewStyle().Bold(true).Width(width).Align(lipgloss.Center).MarginBottom(1)
	b.WriteString(titleStyle.Render("━ Daily Target ━") + "\n")

	// Daily goal fallback
	dailyGoal := avgHours
	if dailyGoal <= 0.1 {
		dailyGoal = 1.0 // Safety fallback so the bar doesn't break if average is 0
	}

	// Render the Streak
	var streakText string
	if streak > 0 {
		streakText = fmt.Sprintf("🔥 %d Day Streak", streak)
	} else {
		streakText = "❄️  No Active Streak"
	}

	streakStyle := lipgloss.NewStyle().
		Foreground(styles.Color2.GetForeground()).
		Bold(true).
		Width(width).
		Align(lipgloss.Center).
		MarginBottom(1)

	b.WriteString(streakStyle.Render(streakText) + "\n")

	// Progress Bar Logic
	percent := 0.0
	if dailyGoal > 0 {
		percent = todayHours / dailyGoal
	}
	if percent > 1.0 {
		percent = 1.0
	}

	barWidth := width - 28
	if barWidth < 10 {
		barWidth = 10
	}
	if barWidth > 25 {
		barWidth = 25
	}

	filledCount := int(percent * float64(barWidth))
	filledBar := styles.Color1.Render(strings.Repeat("█", filledCount))
	emptyBar := styles.SubText.Render(strings.Repeat("░", barWidth-filledCount))

	statsText := fmt.Sprintf("Today: %4.1fh / Avg: %4.1fh", todayHours, dailyGoal)
	statsStyled := styles.Text.Render(statsText)

	progressRow := fmt.Sprintf("%s  %s%s", statsStyled, filledBar, emptyBar)
	progressRowStyled := lipgloss.NewStyle().Width(width).Align(lipgloss.Center).Render(progressRow)
	b.WriteString(progressRowStyled + "\n")

	// 👉 THE NEW FEATURE: Personal Record (Max Hours)
	var bestDayText string
	if maxHours > 0 {
		// Convert "2026-04-03" into "Apr 03, 2026" for a cleaner look
		parsedDate, err := time.Parse("2006-01-02", maxDate)
		prettyDate := maxDate // fallback
		if err == nil {
			prettyDate = parsedDate.Format("Jan 02, 2006")
		}
		bestDayText = fmt.Sprintf("🏆 Record: %4.1fh on %s", maxHours, prettyDate)
	} else {
		bestDayText = "🏆 Record: N/A"
	}

	// Style it slightly faded using SubText so it doesn't distract from the main progress bar
	bestDayStyled := styles.SubText.Copy().Width(width).Align(lipgloss.Center).MarginTop(1).Render(bestDayText)
	b.WriteString(bestDayStyled + "\n")

	return styles.Box.Width(width).Render(b.String())
}
