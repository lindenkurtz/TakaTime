package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// MakeLink wraps text in an OSC 8 ANSI escape sequence to make it clickable
func MakeLink(url, text string) string {
	return fmt.Sprintf("\x1b]8;;%s\x1b\\%s\x1b]8;;\x1b\\", url, text)
}

// 2. The Main View
func (m Model) View() string {
	if !m.Ready {
		return "Initializing..."
	}

	// --- HEADER ---
	logo := m.AppStyles.Title.Render("TakaTime ")

	// 1. Dynamically color the tabs based on the state
	var homeTab, aboutTab string
	if m.ActiveTab == "about" {
		homeTab = m.AppStyles.SubText.Render("Home (H)")
		aboutTab = lipgloss.NewStyle().Foreground(lipgloss.Color(m.TUITheme.Color1)).Bold(true).Render("About (A)")
	} else {
		homeTab = lipgloss.NewStyle().Foreground(lipgloss.Color(m.TUITheme.Color1)).Bold(true).Render("Home (H)")
		aboutTab = m.AppStyles.SubText.Render("About (A)")
	}

	links := fmt.Sprintf("%s %s %s", homeTab, m.AppStyles.SubText.Render("|"), aboutTab)

	gapWidth := m.Width - lipgloss.Width(logo) - lipgloss.Width(links) - 4
	if gapWidth < 0 {
		gapWidth = 0
	}

	// ... the rest of your header gap calculations ...
	header := lipgloss.JoinHorizontal(lipgloss.Center, logo, strings.Repeat(" ", gapWidth), links)
	header = lipgloss.NewStyle().MarginTop(1).MarginBottom(1).Render(header)
	if m.ShowSettings {
		// Use m.viewport.Width and m.viewport.Height to center it!
		return buildSettingsModal(m, m.Width, m.Height)
	}
	// ----------------------------------------------------------------------------------------------
	// --- FOOTER ---
	// Add the scroll percentage to the footer!
	scrollPercent := fmt.Sprintf("Scroll: %3.f%%", m.Viewport.ScrollPercent()*100)
	helpText := m.AppStyles.SubText.Render("q: quit • r: refresh  • S: change Theme • j/k/↑/↓: scroll • " + scrollPercent)

	//  Create the clickable ANSI strings

	//Todo
	githubLink := MakeLink("https://github.com/lindenkurtz/TakaTime", "GitHub: lindenkurtz/TakaTime")
	// discordLink := MakeLink("https://discord.gg/YOUR_DISCORD_LINK", "Discord: TakaTime") // Replace with actual link!

	// Combine them with your pipe separator
	socialsText := fmt.Sprintf("%s ", githubLink)

	//  Render the combined string with your AppStyles
	socials := m.AppStyles.Text.Render(socialsText)

	// Combine into the final footer block
	footerContent := lipgloss.JoinVertical(lipgloss.Center, helpText, socials)
	footer := lipgloss.NewStyle().
		Width(m.Width).
		Align(lipgloss.Center).
		MarginTop(1).
		Render(footerContent)

	// --- COMBINE EVERYTHING ---
	// Notice we use m.Viewport.View() for the middle section!
	return lipgloss.JoinVertical(lipgloss.Top,
		header,
		m.Viewport.View(),
		footer,
	)
}
