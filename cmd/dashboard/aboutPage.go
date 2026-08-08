package main

import (
	"fmt"

	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

// generateAboutContent creates a professional, responsive UI for the About tab
func (m Model) generateAboutContent() string {
	// 1. Set a Max Width for readability (Responsive Design)
	maxWidth := 60
	if m.Viewport.Width-4 < maxWidth {
		maxWidth = m.Viewport.Width - 4 // Shrink if terminal is very small
	}

	// 2. Local Styles for the About Page
	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color(m.TUITheme.Color1)).
		MarginBottom(1)

	headingStyle := lipgloss.NewStyle().
		Foreground(lipgloss.Color(m.TUITheme.Color2)).
		Bold(true).
		MarginTop(1)

	textStyle := m.AppStyles.Text.Copy().Width(maxWidth).Align(lipgloss.Center)
	subTextStyle := m.AppStyles.SubText.Copy().Width(maxWidth).Align(lipgloss.Center)

	// --- SECTION 1: HEADER & MISSION ---
	title := titleStyle.Render("TakaTime")
	desc := textStyle.Render("A seamless, cross-platform time tracking dashboard for developers. Monitor your coding habits across Neovim, VS Code, and beyond without leaving the terminal.")

	// --- SECTION 2: STATUS & MAINTENANCE ---
	statusHeading := headingStyle.Render("Project Status")

	// statusText := subTextStyle.Render("Status: Actively Maintained\nVersion: ")
	statusText := subTextStyle.Render(fmt.Sprintf( "Status: Actively Maintained\nVersion: "+types.Version) )

	// --- SECTION 3: RESOURCES & ISSUES ---
	resourcesHeading := headingStyle.Render("Resources")

	// Assuming you have the MakeLink helper we built earlier!
	github := MakeLink("https://github.com/lindenkurtz/TakaTime", "GitHub Repository")
	issues := MakeLink("https://github.com/lindenkurtz/TakaTime/issues", "Report a Bug")
	// discord := MakeLink("https://discord.gg/YOUR_LINK", "Discord Server")

	linksText := fmt.Sprintf("%s  •  %s  ", github, issues)
	links := textStyle.Render(linksText)

	// --- SECTION 4: LICENSE & CREDITS ---
	licenseHeading := headingStyle.Render("License")
	license := subTextStyle.Render("Distributed under the MIT License.\nFree and open-source forever.")
	author := subTextStyle.MarginTop(2).Render("Originally by Rtarun3606k — fork by lindenkurtz")

	// --- ASSEMBLE EVERYTHING ---
	// Stack all the sections vertically, perfectly centered
	content := lipgloss.JoinVertical(
		lipgloss.Center,
		title,
		desc,
		statusHeading,
		statusText,
		resourcesHeading,
		links,
		licenseHeading,
		license,
		author,
	)

	// Box it up and place it dead center in the viewport
	return lipgloss.Place(
		m.Viewport.Width, m.Viewport.Height,
		lipgloss.Center, lipgloss.Center,
		content,
	)
}
