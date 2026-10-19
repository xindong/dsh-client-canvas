import "./styles.css";

const links = [...document.querySelectorAll<HTMLAnchorElement>(".docs-toc a")];
const sections = links
  .map((link) => document.querySelector<HTMLElement>(link.hash))
  .filter((section): section is HTMLElement => Boolean(section));

const setCurrentSection = (id: string) => {
  for (const link of links) link.classList.toggle("is-current", link.hash === `#${id}`);
};

if (sections.length > 0 && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setCurrentSection(visible.target.id);
    },
    { rootMargin: "-12% 0px -65%", threshold: [0.05, 0.25, 0.6] },
  );
  sections.forEach((section) => observer.observe(section));
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-code")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget ?? "");
    const text = target?.textContent;
    if (!text || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "已复制";
    window.setTimeout(() => { button.textContent = original; }, 1400);
  });
}
