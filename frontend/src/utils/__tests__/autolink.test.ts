import { describe, it, expect } from 'vitest'
import { autoLinkUrls } from '../autolink'

describe('autoLinkUrls', () => {
  it('converts plain URLs to clickable links', () => {
    const input = 'Check out https://example.com for more info'
    const expected = 'Check out <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a> for more info'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('converts www URLs to clickable links', () => {
    const input = 'Visit www.example.com today'
    const expected = 'Visit <a href="http://www.example.com" target="_blank" rel="noopener noreferrer">www.example.com</a> today'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('handles multiple URLs in the same text', () => {
    const input = 'Check https://example.com and www.test.com'
    const expected = 'Check <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a> and <a href="http://www.test.com" target="_blank" rel="noopener noreferrer">www.test.com</a>'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('preserves existing HTML links without double-linking', () => {
    const input = '<a href="https://example.com">Example Site</a> and https://test.com'
    const expected = '<a target="_blank" rel="noopener noreferrer" href="https://example.com">Example Site</a> and <a href="https://test.com" target="_blank" rel="noopener noreferrer">https://test.com</a>'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('handles complex HTML with nested tags', () => {
    const input = '<div><strong>Visit</strong> https://example.com</div>'
    const expected = '<div><strong>Visit</strong> <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a></div>'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('does not link URLs inside HTML attributes', () => {
    const input = '<img src="https://example.com/image.jpg" alt="image" /> Visit https://test.com'
    const result = autoLinkUrls(input)
    expect(result).toContain('<img src="https://example.com/image.jpg" alt="image" />')
    expect(result).toContain('<a href="https://test.com" target="_blank" rel="noopener noreferrer">https://test.com</a>')
  })

  it('handles empty string', () => {
    expect(autoLinkUrls('')).toBe('')
  })

  it('handles text without URLs', () => {
    const input = 'This is just plain text'
    expect(autoLinkUrls(input)).toBe(input)
  })

  it('preserves existing link text and does not modify the href', () => {
    const input = '<a href="https://example.com/path?param=value">Custom Link Text</a>'
    const expected = '<a target="_blank" rel="noopener noreferrer" href="https://example.com/path?param=value">Custom Link Text</a>'
    expect(autoLinkUrls(input)).toBe(expected)
  })

  it('handles URLs at the beginning and end of text', () => {
    const input = 'https://start.com middle text www.end.com'
    const expected = '<a href="https://start.com" target="_blank" rel="noopener noreferrer">https://start.com</a> middle text <a href="http://www.end.com" target="_blank" rel="noopener noreferrer">www.end.com</a>'
    expect(autoLinkUrls(input)).toBe(expected)
  })
})
