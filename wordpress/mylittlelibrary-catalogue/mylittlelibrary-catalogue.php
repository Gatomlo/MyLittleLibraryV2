<?php
/**
 * Plugin Name: MyLittleLibrary – Catalogue
 * Description: Affiche le catalogue (lecture seule) de MyLittleLibrary via le shortcode [bibliotheque]. Compatible Divi 5 (module Texte ou Code).
 * Version: 1.0.0
 * Author: Ranch du Phoenix
 * License: GPL-2.0-or-later
 * Text Domain: mylittlelibrary-catalogue
 */

if (!defined('ABSPATH')) {
    exit;
}

const MLL_OPTION = 'mll_catalogue_url';

/**
 * Shortcode : [bibliotheque url="https://exemple.be/mylittlelibrary" par_page="24" entete="oui"]
 * L'attribut url est facultatif si l'adresse est renseignee dans Reglages > Bibliotheque.
 */
function mll_catalogue_shortcode($atts) {
    $atts = shortcode_atts(array(
        'url'      => get_option(MLL_OPTION, ''),
        'par_page' => 24,
        'entete'   => 'oui',
    ), $atts, 'bibliotheque');

    $url = untrailingslashit(esc_url_raw(trim($atts['url'])));
    if (!$url) {
        return current_user_can('manage_options')
            ? '<p><em>Bibliothèque : renseigne l\'adresse de l\'application dans Réglages &gt; Bibliothèque ou via l\'attribut url du shortcode.</em></p>'
            : '';
    }

    wp_enqueue_script('mll-catalogue', $url . '/embed.js', array(), '1.0.0', array('strategy' => 'defer', 'in_footer' => true));

    return sprintf(
        '<div class="mll-catalogue" data-url="%s" data-per-page="%d" data-header="%s"></div>',
        esc_attr($url),
        max(1, min(100, intval($atts['par_page']))),
        esc_attr($atts['entete'])
    );
}
add_shortcode('bibliotheque', 'mll_catalogue_shortcode');

// ---------- Page de reglage (Reglages > Bibliotheque) ----------
function mll_catalogue_register_settings() {
    register_setting('mll_catalogue', MLL_OPTION, array(
        'type'              => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default'           => '',
    ));
}
add_action('admin_init', 'mll_catalogue_register_settings');

function mll_catalogue_menu() {
    add_options_page('Bibliothèque', 'Bibliothèque', 'manage_options', 'mll-catalogue', 'mll_catalogue_settings_page');
}
add_action('admin_menu', 'mll_catalogue_menu');

function mll_catalogue_settings_page() {
    ?>
    <div class="wrap">
        <h1>Catalogue de la bibliothèque</h1>
        <form method="post" action="options.php">
            <?php settings_fields('mll_catalogue'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="mll_url">Adresse de l'application</label></th>
                    <td>
                        <input type="url" id="mll_url" name="<?php echo esc_attr(MLL_OPTION); ?>" class="regular-text"
                               value="<?php echo esc_attr(get_option(MLL_OPTION, '')); ?>"
                               placeholder="https://exemple.be/mylittlelibrary">
                        <p class="description">Ensuite, place <code>[bibliotheque]</code> dans une page (module Texte ou Code de Divi).
                            Options : <code>par_page="24"</code>, <code>entete="non"</code> pour masquer logo et nom.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
