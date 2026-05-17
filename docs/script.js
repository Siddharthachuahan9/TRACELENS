// TraceLens Landing Page

// Navbar scroll effect
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// Scroll reveal — handles .reveal, .reveal-left, .reveal-right
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -32px 0px' });

document.querySelectorAll('.reveal, .reveal-left, .reveal-right').forEach(el => {
  // Stagger siblings that share the same reveal class and parent
  const cls = [...el.classList].find(c => c === 'reveal' || c === 'reveal-left' || c === 'reveal-right');
  const siblings = Array.from(el.parentElement.children).filter(c => c.classList.contains(cls));
  const idx = siblings.indexOf(el);
  if (idx > 0) el.style.transitionDelay = `${idx * 0.07}s`;
  revealObserver.observe(el);
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Material ripple effect
document.querySelectorAll('.ripple').forEach(el => {
  el.addEventListener('click', (e) => {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
});
