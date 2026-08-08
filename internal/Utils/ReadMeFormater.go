package utils

import "strings"

func GenerateOutput() string {
	var sb strings.Builder

	// 1. Header
	sb.WriteString("<h2 align=\"center\">TakaTime Weekly Report</h2>\n\n")

	// ---------- trial
	// 2. The Dashboard (HTML Grid for alignment)
	// We use 'align="center"' to center everything nicely.
	sb.WriteString("<p align=\"center\">\n")

	// --- ROW 1: TIME STATS (Full Width) ---
	// Keep this 100% so it always fills the available space
	sb.WriteString("  <img src=\"./public/taka-time.png\" width=\"100%\" alt=\"Time Stats\" /><br/>\n")

	// --- ROW 2: LANGUAGES & PROJECTS (Responsive Wrap) ---
	// TRICK: Use a fixed pixel width (e.g., 400).
	// - On Desktop (>850px): 400 + 400 fits side-by-side.
	// - On Mobile (<800px): They won't fit, so the second one wraps to the next line.

	//30 days
	sb.WriteString("  <img src=\"./public/taka-languages30.png\" width=\"400\" alt=\"Languages\" />\n")
	sb.WriteString("  <img src=\"./public/taka-projects30.png\" width=\"400\" alt=\"Projects\" /><br/>\n")

	// All Time
	sb.WriteString("  <img src=\"./public/taka-languages.png\" width=\"400\" alt=\"Languages\" />\n")
	sb.WriteString("  <img src=\"./public/taka-projects.png\" width=\"400\" alt=\"Projects\" /><br/>\n")
	// --- ROW 3: TECH STACK (Full Width) ---
	sb.WriteString("  <img src=\"./public/taka-tech.png\" width=\"100%\" alt=\"Tech Stack\" />\n")

	sb.WriteString("</p>\n\n")
	//----------trial
	// 3. Footer
	sb.WriteString("<p align=\"center\"><em>Generated automatically by <a href=\"https://github.com/lindenkurtz/TakaTime\">TakaTime</a></em></p>")
	return sb.String()
}
