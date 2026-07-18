import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Programme de fidélité Shopify</h1>
        <p className={styles.text}>
          Récompensez automatiquement les achats et les parrainages de vos clients.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Domaine de la boutique</span>
              <input className={styles.input} type="text" name="shop" />
              <span>ex. : ma-boutique.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Se connecter
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Fidélité personnalisable.</strong> Paliers, remises, validité
            et règles de cumul sont gérés depuis Shopify.
          </li>
          <li>
            <strong>Automatisation native.</strong> Les clients et commandes sont
            synchronisés par l&apos;API et les webhooks Shopify.
          </li>
          <li>
            <strong>Parrainage intégré.</strong> Chaque client connecté dispose
            de son lien personnel dans la boutique.
          </li>
        </ul>
      </div>
    </div>
  );
}
