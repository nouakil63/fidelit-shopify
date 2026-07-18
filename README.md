# Programme de fidélité Shopify

Application Shopify embarquée pour gérer un programme de fidélité et de parrainage personnalisé, sans modifier directement le code du thème.

## Fonctionnalités livrées

- tableau de bord dans l'administration Shopify ;
- seuil d'achat, remise fixe ou en pourcentage et durée de validité configurables ;
- récompense unique ou répétée à chaque nouveau palier ;
- règles de cumul avec les remises commande, produit et livraison ;
- synchronisation de la base clients Shopify et de leur montant dépensé à vie ;
- suivi local des commandes payées, remboursées ou annulées ;
- génération d'un code Shopify personnel, limité au client et à une utilisation ;
- envoi transactionnel par e-mail via Resend ;
- programme de parrainage, validé à la première commande payée du filleul ;
- pop-up et espace fidélité injectés par une extension de thème ;
- app proxy signé pour exposer les informations au bon client connecté ;
- webhooks obligatoires de confidentialité et suppression des données.

Le programme est désactivé par défaut. La synchronisation initiale ne crée donc aucun code accidentellement.

## Architecture

```text
Boutique / extension de thème
        │  /apps/fidelite (requête signée Shopify)
        ▼
Application React Router ─── Admin GraphQL ─── Clients, commandes, réductions
        │
        ├── Prisma / SQLite ─── règles, parrainages, récompenses, idempotence
        └── Resend ──────────── e-mails de récompense
```

Le cumul de référence est `Customer.amountSpent`, le montant natif Shopify dépensé par le client sur toute sa durée de vie. Les webhooks resynchronisent ce montant après paiement, annulation ou remboursement. Un index d'idempotence empêche la création du même palier deux fois.

## Prérequis

- Node.js 22.12 ou plus récent ;
- Git 2.28 ou plus récent ;
- Shopify CLI 4 ;
- une boutique de développement puis la boutique cliente ;
- l'autorisation Shopify d'accéder aux données clients protégées ;
- un domaine d'envoi vérifié chez Resend.

## Installation locale

```bash
npm install
shopify app config link
npm run setup
shopify app dev
```

`shopify app config link` remplace les valeurs d'exemple de `shopify.app.toml` par celles de l'application créée dans le Dev Dashboard. Shopify CLI fournit les secrets et l'URL du tunnel pendant `shopify app dev`.

Copier ensuite `.env.example` vers la configuration de l'hébergeur et renseigner au minimum :

```text
RESEND_API_KEY=...
REWARD_EMAIL_FROM=Nom boutique <fidelite@domaine.fr>
```

Ne jamais versionner les vraies clés.

## Mise en service sur la boutique

1. Installer l'application sur une boutique de développement.
2. Dans l'application, cliquer sur **Synchroniser les clients Shopify**.
3. Paramétrer le palier, la récompense, les cumuls, le pop-up et le parrainage.
4. Enregistrer les paramètres en laissant d'abord le programme inactif.
5. Cliquer sur **Activer le pop-up dans le thème**, puis enregistrer le thème.
6. Tester avec un client et une commande de test.
7. Activer le programme.
8. Si l'historique doit être récompensé, cliquer explicitement sur **Émettre les récompenses déjà acquises**. Le traitement se fait par lots de 25 clients pour limiter la charge sur l'API.

## Webhooks

Les abonnements sont déclarés dans `shopify.app.toml` avec l'API `2026-07` :

- `customers/create`, `customers/update` ;
- `orders/paid`, `orders/cancelled`, `refunds/create` ;
- `app/uninstalled`, `app/scopes_update` ;
- `customers/data_request`, `customers/redact`, `shop/redact`.

Les signatures HMAC sont validées par la bibliothèque officielle Shopify. Les webhooks de commande sont rejouables : une commande est mise à jour et une récompense est protégée par une clé unique.

## Vérifications

```bash
npm run typecheck
npm run lint
npm run build
shopify app build
```

Scénario fonctionnel minimal :

1. créer un client avec une adresse e-mail ;
2. synchroniser les clients ;
3. fixer un palier bas sur la boutique de test ;
4. payer une commande ;
5. vérifier la réduction dans **Admin Shopify > Réductions** ;
6. vérifier l'e-mail et l'expiration ;
7. rembourser la commande et contrôler le nouveau cumul ;
8. ouvrir une URL `/?ref=CODE`, créer un second compte puis payer sa première commande ;
9. vérifier les deux récompenses de parrainage ;
10. rejouer le webhook et confirmer qu'aucun doublon n'est créé.

## Déploiement

Le template utilise SQLite pour rendre le développement immédiat. En production, il faut soit :

- une seule instance avec un volume persistant sauvegardé ;
- soit, recommandé pour plusieurs instances, migrer le datasource Prisma vers PostgreSQL avant le lancement.

Ne pas déployer SQLite sur un disque éphémère : les sessions OAuth, le suivi des paliers et l'idempotence seraient perdus au redémarrage.

Variables de production requises : `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `RESEND_API_KEY`, `REWARD_EMAIL_FROM`, `NODE_ENV=production` et `PORT`.

Après déploiement :

```bash
npm run setup
shopify app deploy
```

## Points de conformité

- Les e-mails de récompense sont transactionnels et ne doivent pas être réutilisés comme campagne marketing sans consentement.
- Les codes ciblent uniquement l'identifiant Shopify du bénéficiaire.
- La suppression client cascade sur commandes, récompenses et parrainages locaux.
- `shop/redact` supprime toutes les données de la boutique.
- Pour une publication App Store, compléter le processus opérationnel de remise au marchand des exports générés lors de `customers/data_request` et déclarer précisément l'usage des données clients protégées dans le Dev Dashboard.
