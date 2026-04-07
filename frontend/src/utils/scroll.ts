export function scrollToElementWithOffset(
  element: HTMLElement,
  behavior: ScrollBehavior = 'auto',
  extraOffset = 48
): void {
  // Account for nav bar height via CSS variable set by PageHeader's ResizeObserver
  const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 48;
  // Sticky panels (e.g. Future Meals) sit below the nav with ~24px gap
  const stickyPanels = document.querySelectorAll<HTMLElement>('.sticky.z-\\[9\\]');
  let stickyHeight = 0;
  for (const panel of stickyPanels) {
    stickyHeight += panel.getBoundingClientRect().height;
  }
  const totalOffset = headerH + 24 + stickyHeight + extraOffset;
  const elementTop = element.getBoundingClientRect().top + window.scrollY;
  const targetTop = Math.max(0, elementTop - totalOffset);

  window.scrollTo({ top: targetTop, behavior });
}
