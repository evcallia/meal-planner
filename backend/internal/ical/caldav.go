package ical

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AppleCalDAVURL is the CalDAV endpoint for iCloud calendars.
const AppleCalDAVURL = "https://caldav.icloud.com"

// caldavClient is a minimal CalDAV client covering what the Python `caldav`
// library was used for: principal discovery, listing calendars, and a
// calendar-query REPORT with time-range + server-side recurrence expansion.
type caldavClient struct {
	baseURL  string
	username string
	password string
	http     *http.Client
}

func newCalDAVClient(baseURL, username, password string) *caldavClient {
	return &caldavClient{
		baseURL:  baseURL,
		username: username,
		password: password,
		http:     &http.Client{Timeout: 60 * time.Second},
	}
}

// Calendar is a discovered CalDAV calendar collection.
type Calendar struct {
	Name string
	Href string
}

func (c *caldavClient) request(method, target, depth, body string) ([]byte, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return nil, err
	}
	ref, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	full := u.ResolveReference(ref).String()
	req, err := http.NewRequest(method, full, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	if depth != "" {
		req.Header.Set("Depth", depth)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		// The most common cause in practice: Apple revokes ALL app-specific
		// passwords whenever the Apple ID password changes.
		return nil, fmt.Errorf("caldav %s %s: status 401 — credentials rejected; "+
			"regenerate the app-specific password at appleid.apple.com and update "+
			"APPLE_CALENDAR_APP_PASSWORD", method, target)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("caldav %s %s: status %d", method, target, resp.StatusCode)
	}
	return data, nil
}

// multistatus XML structures (namespace-aware via encoding/xml).
type msResponse struct {
	Href     string `xml:"DAV: href"`
	Propstat []struct {
		Status string `xml:"DAV: status"`
		Prop   struct {
			DisplayName          *string `xml:"DAV: displayname"`
			CurrentUserPrincipal *struct {
				Href string `xml:"DAV: href"`
			} `xml:"DAV: current-user-principal"`
			CalendarHomeSetRaw *struct {
				Href string `xml:"DAV: href"`
			} `xml:"urn:ietf:params:xml:ns:caldav calendar-home-set"`
			ResourceType struct {
				Calendar *struct{} `xml:"urn:ietf:params:xml:ns:caldav calendar"`
			} `xml:"DAV: resourcetype"`
			SupportedComponents *struct {
				Comps []struct {
					Name string `xml:"name,attr"`
				} `xml:"urn:ietf:params:xml:ns:caldav comp"`
			} `xml:"urn:ietf:params:xml:ns:caldav supported-calendar-component-set"`
			CalendarData string `xml:"urn:ietf:params:xml:ns:caldav calendar-data"`
		} `xml:"DAV: prop"`
	} `xml:"DAV: propstat"`
}

type multistatus struct {
	Responses []msResponse `xml:"DAV: response"`
}

func parseMultistatus(data []byte) (*multistatus, error) {
	var ms multistatus
	if err := xml.Unmarshal(data, &ms); err != nil {
		return nil, err
	}
	return &ms, nil
}

func (c *caldavClient) principalHref() (string, error) {
	body := `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`
	data, err := c.request("PROPFIND", "/", "0", body)
	if err != nil {
		return "", err
	}
	ms, err := parseMultistatus(data)
	if err != nil {
		return "", err
	}
	for _, resp := range ms.Responses {
		for _, ps := range resp.Propstat {
			if ps.Prop.CurrentUserPrincipal != nil && ps.Prop.CurrentUserPrincipal.Href != "" {
				return ps.Prop.CurrentUserPrincipal.Href, nil
			}
		}
	}
	return "", fmt.Errorf("caldav: no current-user-principal")
}

func (c *caldavClient) calendarHomeHref(principal string) (string, error) {
	body := `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`
	data, err := c.request("PROPFIND", principal, "0", body)
	if err != nil {
		return "", err
	}
	ms, err := parseMultistatus(data)
	if err != nil {
		return "", err
	}
	for _, resp := range ms.Responses {
		for _, ps := range resp.Propstat {
			if ps.Prop.CalendarHomeSetRaw != nil && ps.Prop.CalendarHomeSetRaw.Href != "" {
				return ps.Prop.CalendarHomeSetRaw.Href, nil
			}
		}
	}
	return "", fmt.Errorf("caldav: no calendar-home-set")
}

// Calendars lists event-capable calendar collections.
func (c *caldavClient) Calendars() ([]Calendar, error) {
	principal, err := c.principalHref()
	if err != nil {
		return nil, err
	}
	home, err := c.calendarHomeHref(principal)
	if err != nil {
		return nil, err
	}
	body := `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`
	data, err := c.request("PROPFIND", home, "1", body)
	if err != nil {
		return nil, err
	}
	ms, err := parseMultistatus(data)
	if err != nil {
		return nil, err
	}
	var calendars []Calendar
	for _, resp := range ms.Responses {
		var name string
		isCalendar, supportsEvents := false, true
		for _, ps := range resp.Propstat {
			if ps.Prop.ResourceType.Calendar != nil {
				isCalendar = true
			}
			if ps.Prop.DisplayName != nil && *ps.Prop.DisplayName != "" {
				name = *ps.Prop.DisplayName
			}
			if sc := ps.Prop.SupportedComponents; sc != nil && len(sc.Comps) > 0 {
				supportsEvents = false
				for _, comp := range sc.Comps {
					if comp.Name == "VEVENT" {
						supportsEvents = true
					}
				}
			}
		}
		if isCalendar && supportsEvents {
			calendars = append(calendars, Calendar{Name: name, Href: resp.Href})
		}
	}
	return calendars, nil
}

// Events runs a calendar-query REPORT over [start, end) with expansion of
// recurring events (mirrors caldav's calendar.search(expand=True)).
func (c *caldavClient) Events(cal Calendar, start, end time.Time) ([][]byte, error) {
	const stamp = "20060102T150405Z"
	startStr, endStr := start.UTC().Format(stamp), end.UTC().Format(stamp)
	body := fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-data>
      <c:expand start="%s" end="%s"/>
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="%s" end="%s"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`, startStr, endStr, startStr, endStr)
	data, err := c.request("REPORT", cal.Href, "1", body)
	if err != nil {
		return nil, err
	}
	ms, err := parseMultistatus(data)
	if err != nil {
		return nil, err
	}
	var out [][]byte
	for _, resp := range ms.Responses {
		for _, ps := range resp.Propstat {
			if ps.Prop.CalendarData != "" {
				out = append(out, []byte(ps.Prop.CalendarData))
			}
		}
	}
	return out, nil
}
