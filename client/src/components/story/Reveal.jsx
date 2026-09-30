import { useEffect, useRef, useState } from 'react';
import { cn } from '../../utils/cn';

/** Fades its children in the first time they scroll into view. */
export default function Reveal({ as: Tag = 'div', delay = 0, className, children, ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={cn('reveal', shown && 'is-visible', className)} style={{ transitionDelay: `${delay}ms` }} {...rest}>
      {children}
    </Tag>
  );
}
