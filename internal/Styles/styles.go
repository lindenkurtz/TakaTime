package Styles

import (
	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

// AppStyles holds all the generated lipgloss styles for a specific theme
type AppStyles struct {
	Title       lipgloss.Style
	Text        lipgloss.Style
	SubText     lipgloss.Style
	Box         lipgloss.Style
	ListLabel   lipgloss.Style
	ListValue   lipgloss.Style
	ListPercent lipgloss.Style

	// Dynamic colors for your bars and graphs
	Color1 lipgloss.Style
	Color2 lipgloss.Style
	Color3 lipgloss.Style
	Color4 lipgloss.Style

	Navbar lipgloss.Style
	Footer lipgloss.Style

	//timestats
	StatCard      lipgloss.Style
	StatCardTitle lipgloss.Style
	StatCardValue lipgloss.Style
}

// InitStyles acts as a factory. You pass in a ThemeConfig, and it returns
// a full set of Lipgloss styles mapped exactly to those colors.
func InitStyles(theme types.ThemeConfig) AppStyles {
	return AppStyles{
		// 1. Headers & Layout
		Title: lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(theme.Color1)). // Use Primary color for Title
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(theme.Color1)). // Match border to title
			Padding(0, 1).
			MarginBottom(1),

		Box: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(theme.SubTextColor)).
			Padding(0, 1).
			MarginBottom(1),

		// 2. Base Text
		Text: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.TextColor)),

		SubText: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.SubTextColor)),

		// 3. Formatted Lists (Perfect for your Language/Project stats)
		ListLabel: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.TextColor)).
			Bold(true).
			Width(15), // Matches the %-15s formatting you used earlier!

		ListValue: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.SubTextColor)).
			Width(10), // Matches your %-10s

		ListPercent: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.Color2)). // Green for percentages looks great
			Italic(true),

		// 4. Raw Colors (Useful for rendering progress bars)
		Color1: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color1)),
		Color2: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color2)),
		Color3: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color3)),
		Color4: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color4)),

		// Navbar: Purple background, white text, padded
		Navbar: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.BackgroundColor)). // Swap text/bg for contrast
			Background(lipgloss.Color(theme.Color1)).
			Padding(0, 1).
			MarginBottom(1),

		// Footer: Centered, subtle text
		Footer: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.SubTextColor)).
			MarginTop(1),

		StatCard: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(theme.SubTextColor)).
			Padding(0, 1).
			Align(lipgloss.Center), // Center the text inside the card

		StatCardTitle: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.SubTextColor)).
			MarginBottom(1), // Add a space between title and value

		StatCardValue: lipgloss.NewStyle().
			Foreground(lipgloss.Color(theme.Color1)). // Primary color for the big numbers!
			Bold(true),
	}
}

// BuildStyles compiles raw hex codes from a theme into Lipgloss styles
func BuildStyles(theme types.ThemeConfig) AppStyles {
	return AppStyles{
		// 1. Primary and Secondary Accent Colors
		Color1: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color1)),
		Color2: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color2)),
		Color3: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color3)), // Added!
		Color4: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color4)), // Added!

		// 2. Standard Text Colors
		Title:   lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color1)).Bold(true), // Added!
		Text:    lipgloss.NewStyle().Foreground(lipgloss.Color(theme.TextColor)),
		SubText: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.SubTextColor)),

		// 3. Layout Elements
		Navbar: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color2)).Bold(true), // Added!
		Footer: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.SubTextColor)),      // Added!

		// 4. The outer border style for your main boxes
		Box: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(theme.BarBackgroundColor)).
			Padding(1, 2),

		// 5. Standardized list styles
		ListLabel:   lipgloss.NewStyle().Foreground(lipgloss.Color(theme.TextColor)).Bold(true),
		ListValue:   lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color1)),
		ListPercent: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.SubTextColor)).Italic(true),

		// 6. Stat Card Styles (Added!)
		StatCard: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(theme.BarBackgroundColor)).
			Padding(0, 1), // Tighter padding for smaller stat cards
		StatCardTitle: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.SubTextColor)),
		StatCardValue: lipgloss.NewStyle().Foreground(lipgloss.Color(theme.Color1)).Bold(true),
	}
}
