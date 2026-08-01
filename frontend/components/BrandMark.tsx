import Image from "next/image";

export function BrandMark({
  size = 30,
  className = "",
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/weasley-frame-mark.png"
      alt="Weasley Frame"
      width={size}
      height={size}
      className={className}
      priority={priority}
    />
  );
}
