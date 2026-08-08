package main

import (
	"fmt"
	"strings"

	"github.com/lindenkurtz/TakaTime/internal/types"
	"github.com/charmbracelet/lipgloss"
)

func buildSettingsModal(m Model, width int, height int) string {
	modalStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(m.AppStyles.Color1.GetForeground()).
		Padding(1, 4).
		Align(lipgloss.Left)

	var content strings.Builder
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.AppStyles.Color2.GetForeground())
	content.WriteString(titleStyle.Render("🎨 SELECT THEME") + "\n\n")

	// Draw themes in a 2-column grid so they fit beautifully!
	for i := 0; i < len(types.AvailableThemes); i += 2 {
		row := ""

		// Column 1
		if m.SettingsCursor == i {
			row += m.AppStyles.Color1.Render(fmt.Sprintf("> %-15s", types.AvailableThemes[i]))
		} else {
			row += m.AppStyles.SubText.Render(fmt.Sprintf("  %-15s", types.AvailableThemes[i]))
		}

		// Column 2 (Make sure we don't go out of bounds on odd numbers)
		if i+1 < len(types.AvailableThemes) {
			if m.SettingsCursor == i+1 {
				row += m.AppStyles.Color1.Render(fmt.Sprintf("> %-15s", types.AvailableThemes[i+1]))
			} else {
				row += m.AppStyles.SubText.Render(fmt.Sprintf("  %-15s", types.AvailableThemes[i+1]))
			}
		}

		content.WriteString(row + "\n")
	}

	content.WriteString("\n" + m.AppStyles.SubText.Render("Press [Enter] to apply, [Esc] to cancel"))

	modalBox := modalStyle.Render(content.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, modalBox)
}
