package textutil

// A faithful port of the pieces of Python's difflib.SequenceMatcher used by
// CarryItemizedState (autojunk=False, no junk heuristics): matching blocks,
// opcodes, and ratio.

type Opcode struct {
	Tag            string
	I1, I2, J1, J2 int
}

type match struct{ a, b, size int }

type matcher struct {
	a, b []string
	b2j  map[string][]int
}

func newMatcher(a, b []string) *matcher {
	m := &matcher{a: a, b: b, b2j: map[string][]int{}}
	for j, s := range b {
		m.b2j[s] = append(m.b2j[s], j)
	}
	return m
}

func (m *matcher) findLongestMatch(alo, ahi, blo, bhi int) match {
	besti, bestj, bestsize := alo, blo, 0
	j2len := map[int]int{}
	for i := alo; i < ahi; i++ {
		newj2len := map[int]int{}
		for _, j := range m.b2j[m.a[i]] {
			if j < blo {
				continue
			}
			if j >= bhi {
				break
			}
			k := j2len[j-1] + 1
			newj2len[j] = k
			if k > bestsize {
				besti, bestj, bestsize = i-k+1, j-k+1, k
			}
		}
		j2len = newj2len
	}
	// Junk-extension steps from CPython are no-ops without junk elements.
	return match{besti, bestj, bestsize}
}

func (m *matcher) matchingBlocks() []match {
	type quad struct{ alo, ahi, blo, bhi int }
	queue := []quad{{0, len(m.a), 0, len(m.b)}}
	var blocks []match
	for len(queue) > 0 {
		q := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		x := m.findLongestMatch(q.alo, q.ahi, q.blo, q.bhi)
		if x.size > 0 {
			blocks = append(blocks, x)
			if q.alo < x.a && q.blo < x.b {
				queue = append(queue, quad{q.alo, x.a, q.blo, x.b})
			}
			if x.a+x.size < q.ahi && x.b+x.size < q.bhi {
				queue = append(queue, quad{x.a + x.size, q.ahi, x.b + x.size, q.bhi})
			}
		}
	}
	// Sort blocks (they were produced in arbitrary order) and merge adjacent.
	sortMatches(blocks)
	var merged []match
	i1, j1, k1 := 0, 0, 0
	for _, b := range blocks {
		if i1+k1 == b.a && j1+k1 == b.b {
			k1 += b.size
		} else {
			if k1 > 0 {
				merged = append(merged, match{i1, j1, k1})
			}
			i1, j1, k1 = b.a, b.b, b.size
		}
	}
	if k1 > 0 {
		merged = append(merged, match{i1, j1, k1})
	}
	merged = append(merged, match{len(m.a), len(m.b), 0})
	return merged
}

func sortMatches(blocks []match) {
	// Insertion sort by (a, b, size) — block counts are tiny here.
	for i := 1; i < len(blocks); i++ {
		for j := i; j > 0; j-- {
			x, y := blocks[j], blocks[j-1]
			if x.a < y.a || (x.a == y.a && (x.b < y.b || (x.b == y.b && x.size < y.size))) {
				blocks[j], blocks[j-1] = y, x
			} else {
				break
			}
		}
	}
}

// Opcodes mirrors SequenceMatcher.get_opcodes for string slices.
func Opcodes(a, b []string) []Opcode {
	m := newMatcher(a, b)
	var ops []Opcode
	i, j := 0, 0
	for _, blk := range m.matchingBlocks() {
		tag := ""
		if i < blk.a && j < blk.b {
			tag = "replace"
		} else if i < blk.a {
			tag = "delete"
		} else if j < blk.b {
			tag = "insert"
		}
		if tag != "" {
			ops = append(ops, Opcode{tag, i, blk.a, j, blk.b})
		}
		i, j = blk.a+blk.size, blk.b+blk.size
		if blk.size > 0 {
			ops = append(ops, Opcode{"equal", blk.a, i, blk.b, j})
		}
	}
	return ops
}

// Ratio mirrors SequenceMatcher.ratio() for two strings compared rune-wise.
func Ratio(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	sa := make([]string, len(ra))
	for i, r := range ra {
		sa[i] = string(r)
	}
	sb := make([]string, len(rb))
	for i, r := range rb {
		sb[i] = string(r)
	}
	m := newMatcher(sa, sb)
	matches := 0
	for _, blk := range m.matchingBlocks() {
		matches += blk.size
	}
	if len(sa)+len(sb) == 0 {
		return 1
	}
	return 2 * float64(matches) / float64(len(sa)+len(sb))
}
