// Package textutil ports the pure text logic: stores.to_title_case,
// days._split_note_lines / _carry_itemized_state, and the subset of Python's
// difflib.SequenceMatcher they depend on.
package textutil

import (
	"regexp"
	"strings"
	"unicode"
)

// ToTitleCase capitalizes after whitespace/start of string only (preserving
// apostrophes, unlike Python's str.title()).
func ToTitleCase(name string) string {
	runes := []rune(strings.TrimSpace(name))
	prevSpace := true
	for i, r := range runes {
		if prevSpace && !unicode.IsSpace(r) {
			runes[i] = unicode.ToUpper(r)
		}
		prevSpace = unicode.IsSpace(r)
	}
	return string(runes)
}

var (
	reBr       = regexp.MustCompile(`(?i)<br\s*/?>`)
	reDivJoin  = regexp.MustCompile(`(?i)</div>\s*<div>`)
	reDivOpen  = regexp.MustCompile(`(?i)<div>`)
	reDivClose = regexp.MustCompile(`(?i)</div>`)
	rePJoin    = regexp.MustCompile(`(?i)</p>\s*<p[^>]*>`)
	rePOpen    = regexp.MustCompile(`(?i)<p[^>]*>`)
	rePClose   = regexp.MustCompile(`(?i)</p>`)
	reTags     = regexp.MustCompile(`<[^>]*>`)
)

// SplitNoteLines mirrors days._split_note_lines: normalize HTML block breaks
// to newlines, then keep lines with visible text.
func SplitNoteLines(notes string) []string {
	normalized := strings.ReplaceAll(notes, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	normalized = reBr.ReplaceAllString(normalized, "\n")
	normalized = reDivJoin.ReplaceAllString(normalized, "\n")
	normalized = reDivOpen.ReplaceAllString(normalized, "\n")
	normalized = reDivClose.ReplaceAllString(normalized, "")
	normalized = rePJoin.ReplaceAllString(normalized, "\n")
	normalized = rePOpen.ReplaceAllString(normalized, "\n")
	normalized = rePClose.ReplaceAllString(normalized, "")
	var filtered []string
	for _, line := range strings.Split(normalized, "\n") {
		if strings.TrimSpace(reTags.ReplaceAllString(line, "")) != "" {
			filtered = append(filtered, line)
		}
	}
	return filtered
}

// NormalizeLine mirrors days._normalize_line.
func NormalizeLine(line string) string {
	return strings.ToLower(strings.TrimSpace(reTags.ReplaceAllString(line, "")))
}

// ItemizedCarrySimilarity is the minimum text similarity for an edited line
// to keep its itemized state.
const ItemizedCarrySimilarity = 0.6

// CarryItemizedState mirrors days._carry_itemized_state: sequence alignment
// for unchanged/edited lines plus a content-matching pass for moved lines.
func CarryItemizedState(oldLines, newLines []string, oldItemized map[int]bool) []bool {
	oldNorm := make([]string, len(oldLines))
	for i, l := range oldLines {
		oldNorm[i] = NormalizeLine(l)
	}
	newNorm := make([]string, len(newLines))
	for i, l := range newLines {
		newNorm[i] = NormalizeLine(l)
	}
	result := make([]bool, len(newNorm))
	matchedOld := map[int]bool{}
	matchedNew := map[int]bool{}

	for _, op := range Opcodes(oldNorm, newNorm) {
		switch op.Tag {
		case "equal":
			for k := 0; k < op.I2-op.I1; k++ {
				result[op.J1+k] = oldItemized[op.I1+k]
				matchedOld[op.I1+k] = true
				matchedNew[op.J1+k] = true
			}
		case "replace":
			n := op.I2 - op.I1
			if m := op.J2 - op.J1; m < n {
				n = m
			}
			for k := 0; k < n; k++ {
				if Ratio(oldNorm[op.I1+k], newNorm[op.J1+k]) < ItemizedCarrySimilarity {
					// Rewritten into something else, not edited — leave both
					// sides for the content-match pass / reset.
					continue
				}
				result[op.J1+k] = oldItemized[op.I1+k]
				matchedOld[op.I1+k] = true
				matchedNew[op.J1+k] = true
			}
		}
	}

	remainingOld := map[string][]int{}
	for i, text := range oldNorm {
		if !matchedOld[i] {
			remainingOld[text] = append(remainingOld[text], i)
		}
	}
	for j, text := range newNorm {
		if matchedNew[j] {
			continue
		}
		if candidates := remainingOld[text]; len(candidates) > 0 {
			result[j] = oldItemized[candidates[0]]
			remainingOld[text] = candidates[1:]
		}
	}
	return result
}
