// backend/internal/recipekeeper/headers.go
package recipekeeper

import "net/http"

// APIVersion is the protocol version this client speaks. The server branches on
// it, so it is pinned rather than inferred — see docs/recipe-keeper-api.md.
const APIVersion = "10"

// Headers are the X-RK-* headers the app sends on every request, including
// /token. Which of them the server enforces is unknown, so we send the full set.
type Headers struct {
	AppOS        string
	AppOSVersion string
	AppVersion   string
	DeviceID     string
	ReceiptID    string
}

func (h Headers) apply(req *http.Request) {
	req.Header.Set("X-RK-APIVersion", APIVersion)
	req.Header.Set("X-RK-AppOS", h.AppOS)
	req.Header.Set("X-RK-AppOSVersion", h.AppOSVersion)
	req.Header.Set("X-RK-AppVersion", h.AppVersion)
	req.Header.Set("X-RK-DeviceId", h.DeviceID)
	req.Header.Set("X-RK-ReceiptId", h.ReceiptID)
	req.Header.Set("X-RK-Analytics", "")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
}

// DefaultHeaders mirrors the captured iOS client. DeviceID must be stable
// across restarts — a fresh id per request looks like an unbounded device fleet.
func DefaultHeaders(deviceID, receiptID string) Headers {
	return Headers{
		AppOS: "iOS", AppOSVersion: "26.6.2", AppVersion: "3.46.2",
		DeviceID: deviceID, ReceiptID: receiptID,
	}
}
