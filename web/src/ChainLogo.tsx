// Small marks for the wallets and the networks the Ethereum wallet works on, drawn here (no images
// fetched): each in its network's own colour, simplified, to tell them apart at a glance.
import type { ReactNode } from "react";

export type LogoId = "solana" | "ethereum" | "bitcoin" | "tron" | "eth" | "bnb" | "base" | "pol" | "arb" | "op" | "avax" | "usdt" | "test";

const disc = (fill: string, inner: ReactNode, size: number, stroke?: string) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="16" cy="16" r="16" fill={fill} />
    {stroke && <circle cx="16" cy="16" r="15.5" fill="none" stroke={stroke} />}
    {inner}
  </svg>
);
const ethDiamond = (light: string, dark: string) => (
  <>
    <path d="M16 5 9.5 16.3 16 20.1l6.5-3.8Z" fill={light} />
    <path d="M16 5v15.1l6.5-3.8Z" fill={dark} />
    <path d="M16 21.5 9.5 17.7 16 27l6.5-9.3Z" fill={light} />
    <path d="M16 21.5V27l6.5-9.3Z" fill={dark} />
  </>
);

export function ChainLogo({ id, size = 32 }: { id: LogoId; size?: number }) {
  switch (id) {
    case "solana":
      return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="sol-g" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#9945ff" />
              <stop offset="1" stopColor="#14f195" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="16" fill="#0b0b12" />
          <path d="M10.4 20.6h12.8l-2.6 2.6H7.8Zm0-5.9h12.8l-2.6 2.6H7.8Zm2.6-5.9h12.8l-2.6 2.6H10.4Z" fill="url(#sol-g)" />
        </svg>
      );
    case "ethereum":
      return disc("#eef1fb", ethDiamond("#8a92b2", "#3c3c3d"), size);
    case "eth":
      return disc("#2a2f45", ethDiamond("#c5cbe3", "#8a92b2"), size);
    case "bitcoin":
      return disc("#f7931a", <text x="16" y="22.5" textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">₿</text>, size);
    case "tron":
      return disc("#eb0029", <path d="M9 9.5 24 12.3l-7.6 11.2Zm2.2 1.6 4.9 10.1.6-6.3Zm6.4 4.1-.6 5.9 5.5-8.1Zm-4.9-3.9 5.3 3.4 3.1-1.7Z" fill="#fff" />, size);
    case "bnb":
      return disc("#f0b90b", <path d="m16 8 2.5 2.5-2.5 2.5-2.5-2.5Zm-5 5 2.5 2.5-2.5 2.5-2.5-2.5Zm10 0 2.5 2.5-2.5 2.5-2.5-2.5Zm-5 0 2.5 2.5-2.5 2.5-2.5-2.5Zm0 5 2.5 2.5-2.5 2.5-2.5-2.5Z" fill="#fff" />, size);
    case "base":
      return disc("#0052ff", <path d="M16 25a9 9 0 1 0-8.96-9.8h11.8v1.6H7.04A9 9 0 0 0 16 25Z" fill="#fff" />, size);
    case "pol":
      return disc("#8247e5", <path d="m19.6 12.7-3.1-1.8a1 1 0 0 0-1 0l-3.1 1.8a1 1 0 0 0-.5.9v1.6l-1.4-.8v-1.4l2.4-1.4 2.4 1.4v1.1l1.5-.9v-1a1 1 0 0 0-.5-.9l-2.9-1.7a1 1 0 0 0-1 0L9.5 12a1 1 0 0 0-.5.9v3.4a1 1 0 0 0 .5.9l2.9 1.7a1 1 0 0 0 1 0l3.1-1.8.1-.1v-1.6l1.4.8v1.4l-2.4 1.4-2.4-1.4v-1.1l-1.5.9v1a1 1 0 0 0 .5.9l2.9 1.7a1 1 0 0 0 1 0l2.9-1.7a1 1 0 0 0 .5-.9v-3.4a1 1 0 0 0-.5-.9Z" fill="#fff" transform="translate(1.5 0)" />, size);
    case "arb":
      return disc("#213147", <path d="M16 6.5 24.5 11.4v9.2L16 25.5l-8.5-4.9v-9.2Zm-1.2 6.2-3.6 9.1 1.6.9 2.8-7.2 2.8 7.2 1.6-.9-3.6-9.1Z" fill="#28a0f0" />, size, "#9dcced");
    case "op":
      return disc("#ff0420", <text x="16" y="20.3" textAnchor="middle" fontSize="11" fontWeight="800" fill="#fff" fontFamily="Arial, sans-serif" fontStyle="italic">OP</text>, size);
    case "avax":
      return disc("#e84142", <path d="M16.9 9.2c-.4-.7-1.4-.7-1.8 0l-6.3 11.1c-.4.7.1 1.5.9 1.5h3.3c.6 0 1.1-.3 1.4-.8l3.9-6.8Zm3.6 6.3c-.4-.7-1.4-.7-1.8 0l-2.6 4.5c-.4.7.1 1.5.9 1.5h5.2c.8 0 1.3-.8.9-1.5Z" fill="#fff" />, size);
    case "usdt":
      return disc("#26a17b", <path d="M8.5 9.5h15v3h-6v2c3.3.2 5.8.9 5.8 1.7s-2.5 1.5-5.8 1.7V24h-3v-6.1c-3.3-.2-5.8-.9-5.8-1.7s2.5-1.5 5.8-1.7v-2h-6Zm6 6.1v1.5h3v-1.5c2.4.1 4.2.5 4.2.9s-1.8.8-4.2.9a26 26 0 0 1-3 0c-2.4-.1-4.2-.5-4.2-.9s1.8-.8 4.2-.9Z" fill="#fff" />, size);
    default:
      return disc("#3a4058", <text x="16" y="20.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#c6d2f0" fontFamily="Arial, sans-serif">T</text>, size);
  }
}
