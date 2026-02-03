export function scrollToElementWithOffset(
  element: HTMLElement,
  behavior: ScrollBehavior = 'auto',
  extraOffset = 12
): void {
  const header = document.querySelector('header');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const elementTop = element.getBoundingClientRect().top + window.scrollY;
  const targetTop = Math.max(0, elementTop - headerHeight - extraOffset);

  window.scrollTo({ top: targetTop, behavior });
}
