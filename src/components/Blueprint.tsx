import type { CSSProperties, ReactNode } from "react";

/** Wraps children in the design system's ".blueprint" wireframe frame with corner registration marks. */
export function Blueprint({
  children,
  style,
  className,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div className={`blueprint${className ? ` ${className}` : ""}`} style={style} onClick={onClick}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}
