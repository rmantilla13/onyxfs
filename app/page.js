import { redirect } from 'next/navigation';

// Onyx has one home, and it is the library.
export default function Home() {
  redirect('/files');
}
