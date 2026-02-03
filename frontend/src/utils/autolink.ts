// Convert URLs in HTML to clickable links, avoiding URLs already in HTML tags
export function autoLinkUrls(html: string): string {
  // Split HTML into text nodes and HTML tags to process only text content
  const parts: Array<{ type: 'text' | 'tag', content: string }> = [];
  let currentIndex = 0;
  
  // Find all HTML tags
  const tagRegex = /<[^>]+>/g;
  let match;
  
  while ((match = tagRegex.exec(html)) !== null) {
    // Add text before the tag
    if (match.index > currentIndex) {
      const textContent = html.slice(currentIndex, match.index);
      if (textContent) {
        parts.push({ type: 'text', content: textContent });
      }
    }
    
    // Add the tag
    parts.push({ type: 'tag', content: match[0] });
    currentIndex = match.index + match[0].length;
  }
  
  // Add remaining text after the last tag
  if (currentIndex < html.length) {
    const textContent = html.slice(currentIndex);
    if (textContent) {
      parts.push({ type: 'text', content: textContent });
    }
  }
  
  // If no HTML tags were found, treat the entire string as text
  if (parts.length === 0) {
    parts.push({ type: 'text', content: html });
  }
  
  // Process only text parts for URL linking
  const urlRegex = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/gi;
  const anchorOpenRegex = /^<a\b[^>]*>/i;
  
  return parts.map(part => {
    if (part.type === 'text') {
      return part.content.replace(urlRegex, (url) => {
        let href = url;
        
        // Add protocol if it starts with www
        if (url.toLowerCase().startsWith('www.')) {
          href = 'http://' + url;
        }
        
        // Return the link HTML
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });
    } else {
      // Ensure existing anchors open in a new tab
      if (anchorOpenRegex.test(part.content)) {
        let updated = part.content;
        const needsTarget = !/\btarget\s*=/.test(updated);
        const needsRel = !/\brel\s*=/.test(updated);
        if (needsTarget || needsRel) {
          const extras = `${needsTarget ? ' target="_blank"' : ''}${needsRel ? ' rel="noopener noreferrer"' : ''}`;
          updated = updated.replace(/^<a\b/i, `<a${extras}`);
        }
        return updated;
      }
      // Return other HTML tags unchanged
      return part.content;
    }
  }).join('');
}
