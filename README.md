# Maintenance Control pour MeshCentral

Plugin d’administration et de dépannage Windows. L’accueil **Santé du parc** présente les alertes disque et les postes à redémarrer, avec une recherche et un filtre par salle.

## Outils disponibles

- **Santé du parc** : alertes, espace disque, durée de fonctionnement et dernier démarrage ; actualisation toutes les cinq minutes.
- **Nettoyage** : fichiers temporaires, caches des navigateurs, composants Windows et profils inactifs ; sélection des postes et confirmation avant exécution.
- **Périphériques** : inventaire et actions sur les périphériques Windows.
- **Pilotes** : bibliothèque de packs ZIP, dépôt de fichiers, installation et historique par poste.
- **Événements** : consultation et filtrage des journaux Windows.
- **Registre** : consultation, modification et modèles applicables à plusieurs postes.
- **Connexions** : sessions Windows, conflits en cours, historique des conflits et journal des décisions conservés 30 jours ; règle optionnelle de refus ou de remplacement d’une session.

Le contrôle des connexions multiples reste distinct du mode Examen, supprimé en version **0.15.0**. Son fonctionnement côté serveur et agent est conservé.

## Installation et mise à jour

Utiliser le manifeste dans le gestionnaire de plugins MeshCentral :

```text
https://raw.githubusercontent.com/V3locidad/maintctl-meshcentral/main/config.json
```

Après mise à jour, recharger le plugin et sa page d’administration. Le module agent a également changé : si un MeshAgent conserve l’ancien module, le redémarrer pour charger la nouvelle version.

Copier `maintctl-config.json.example` vers `maintctl-config.json` dans le dossier du plugin pour définir `driversDir`, un répertoire accessible depuis le serveur MeshCentral. Les packs contiennent les fichiers INF et leurs dépendances. La section `multiLogin` se configure également dans l’onglet Connexions. Préserver la configuration et les fichiers d’historique lors d’une mise à jour.

## Passage de 0.14.x à 0.15.0

Le mode Examen est entièrement retiré : onglet, commandes HTTP et actions agent. Les anciennes URL d’action renvoient une erreur 404. Aucun nouveau verrouillage Examen ne peut être créé par cette version.

**Si un verrouillage Examen est encore actif sur un poste, le déverrouiller avec l’ancienne version avant la mise à jour.** Retirer le code du plugin ne retire pas les règles de pare-feu déjà créées dans Windows. L’ancienne tâche Windows `MAINTCTL_EXAM_UNLOCK`, lorsqu’elle a bien été créée, est indépendante du plugin ; vérifier le déverrouillage effectif du poste.

Si la mise à jour a déjà été faite et qu’un verrouillage subsiste, un administrateur Windows peut retirer les seules règles créées par l’ancien module : `MAINTCTL_EXAM_BLOCK_ALL`, `MAINTCTL_EXAM_ALLOW_LOOPBACK` et `MAINTCTL_EXAM_ALLOW_<numéro>`. Ne pas réinitialiser l’ensemble du pare-feu. Aucune suppression de règles à distance n’est exécutée automatiquement par la mise à jour.

## Utilisation de l’interface

- « Cocher la liste » sélectionne les résultats affichés par la recherche (nom, salle, système ou modèle) et le filtre en ligne. Les sélections précédentes hors filtre restent sélectionnées ; « Aucun » les efface toutes.
- Le nettoyage nécessite au moins un poste et une tâche cochés. Les options ne changent pas les opérations Windows existantes.
- La recherche Santé filtre les cartes et la liste d’alertes. Les trois compteurs restent ceux du parc complet.
- La recherche Connexions filtre les sessions, conflits et décisions reçus du serveur. Les historiques sont limités aux 500 entrées les plus récentes de chaque catégorie à l’écran.
- Les actualisations de Santé et Connexions conservent les données précédentes en cas d’erreur et évitent de remplacer un contenu identique.
- Les réglages Connexions saisis sont conservés pendant les actualisations. « Annuler les modifications » restaure les derniers réglages reçus ; « Enregistrer la règle » applique les changements.
- Les onglets sont accessibles au clavier (flèches gauche/droite, Début/Fin).

## Vérification locale

Sans dépendance npm supplémentaire, avec Node.js 18 ou supérieur :

```sh
node --check maintctl.js
node --check modules_meshcore/maintctl.js
node --test test/*.test.js
```

Les tests utilisent une base MeshCentral, des agents et un DOM simulés. Ils vérifient le retrait du mode Examen, le parcours de nettoyage, la conservation des historiques, les filtres et sélections, les actualisations et les saisies concurrentes. Ils n’exécutent aucune commande sur un poste Windows réel.
